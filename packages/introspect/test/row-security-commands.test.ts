import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pkg from 'pg';
import { introspect } from '../src/index.js';
import { deniedCommands } from '../src/rowSecurity.js';
import { setupDatabase, type DatabaseHandle } from '@kozou/test-utils';

// RLS is enforced per command; `hasPolicies` is per table. A table can report
// enabled + hasPolicies, hold the GRANT, and still refuse every INSERT, because
// the only policy written was FOR SELECT. Everything the agent is told is
// accurate and none of it predicts the refusal.
//
// `deniedCommands` closes that gap in the one direction that is sound without
// reading a policy expression. This file is where the direction is established
// against a real server rather than argued: each table differs only in how its
// single policy is written, and a non-owner role tries the command for real.
//
// The roles are named after the suite's random schema because CREATE ROLE is
// cluster-global: several suites share one PostgreSQL in CI, and a fixed name
// would collide with a concurrent run rather than fail cleanly.
const fixtureSql = (otherRole: string) => `
  -- One policy FOR ALL. Stored as polcmd '*', which a per-command count reads
  -- as "no INSERT policy" — the dangerous direction, since INSERT works.
  CREATE TABLE all_commands (id int PRIMARY KEY, tenant text);
  ALTER TABLE all_commands ENABLE ROW LEVEL SECURITY;
  CREATE POLICY p ON all_commands FOR ALL USING (true) WITH CHECK (true);

  -- The headline case: one policy, FOR SELECT only. Reading is possible;
  -- writing is refused however the privileges are granted.
  CREATE TABLE select_only (id int PRIMARY KEY, tenant text);
  ALTER TABLE select_only ENABLE ROW LEVEL SECURITY;
  CREATE POLICY p ON select_only FOR SELECT USING (true);
  -- Seeded by the owner (RLS does not apply to it here), so "zero rows" below
  -- means the policy refused them rather than that there were none.
  INSERT INTO select_only VALUES (1, 'seed');

  -- Restrictive policies never grant. A command whose only policy is
  -- restrictive is still default-deny.
  CREATE TABLE restrictive_only (id int PRIMARY KEY, tenant text);
  ALTER TABLE restrictive_only ENABLE ROW LEVEL SECURITY;
  CREATE POLICY p ON restrictive_only AS RESTRICTIVE FOR INSERT WITH CHECK (true);
  INSERT INTO restrictive_only VALUES (1, 'seed');

  -- A permissive policy FOR INSERT that names a role the prober is not. The
  -- roles a policy names are deliberately never read, so insert stays off the
  -- list here while the prober's INSERT is refused anyway. This is where the
  -- incompleteness is measured rather than asserted.
  CREATE TABLE insert_other_role (id int PRIMARY KEY, tenant text);
  ALTER TABLE insert_other_role ENABLE ROW LEVEL SECURITY;
  CREATE POLICY p ON insert_other_role FOR INSERT TO "${otherRole}" WITH CHECK (true);
`;

describe('introspect: which commands row-level security refuses', () => {
  let db: DatabaseHandle;
  let role: string;
  const roles: string[] = [];

  const run = () => introspect({ connection: db.connectionString, schemas: [db.schema] });
  const rlsOf = async (name: string) => {
    const r = await run();
    return r.tables.find((t) => t.name === name)!.rowSecurity!;
  };

  /** Run a statement as the non-owner role. Returns the error's SQLSTATE, or
   *  the number of rows the statement read or touched when it succeeded.
   *
   *  Both outcomes are needed because RLS refuses in two different shapes, and
   *  the difference is the point: an INSERT with no permissive policy raises
   *  42501, while a SELECT, UPDATE or DELETE simply matches nothing. The
   *  second is the failure an agent cannot see. */
  const asRole = async (sql: string): Promise<{ code?: string; rowCount: number }> => {
    const client = new pkg.Client({ connectionString: db.connectionString });
    await client.connect();
    try {
      await client.query(`SET ROLE "${role}"`);
      await client.query(`SET search_path TO "${db.schema}"`);
      const res = await client.query(sql);
      return { rowCount: res.rowCount ?? 0 };
    } catch (err) {
      return { code: (err as { code?: string }).code, rowCount: 0 };
    } finally {
      await client.end();
    }
  };

  beforeAll(async () => {
    db = await setupDatabase();
    role = `${db.schema}_probe`;
    // The role a policy is allowed to name — it never connects, it only has to
    // exist for `CREATE POLICY ... TO` to resolve it.
    const otherRole = `${db.schema}_other`;
    const client = new pkg.Client({ connectionString: db.connectionString });
    await client.connect();
    try {
      await client.query(`CREATE SCHEMA "${db.schema}"`);
      await client.query(`SET search_path TO "${db.schema}"`);
      // Both roles first: one of the policies below names the second one.
      // Recorded as they are created, so teardown drops exactly what exists.
      for (const r of [role, otherRole]) {
        await client.query(`CREATE ROLE "${r}"`);
        roles.push(r);
      }
      await client.query(fixtureSql(otherRole));
      await client.query(`GRANT USAGE ON SCHEMA "${db.schema}" TO "${role}"`);
      // Every privilege the commands below need: the point of the fixture is
      // that RLS refuses them anyway.
      await client.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${db.schema}" TO "${role}"`,
      );
    } finally {
      await client.end();
    }
  }, 120_000);

  afterAll(async () => {
    if (!db) return;
    // The container has to come down whatever happened to the roles: a
    // `beforeAll` that fails partway leaves them in an unknown state, and a
    // throw from here would otherwise strand the container and bury the real
    // failure under a teardown one.
    try {
      const client = new pkg.Client({ connectionString: db.connectionString });
      await client.connect();
      try {
        for (const r of roles) {
          // A role holding privileges cannot be dropped; DROP OWNED clears the
          // grants this suite made. Global objects, so they are cleaned up
          // explicitly rather than left for the schema drop.
          await client.query(`DROP OWNED BY "${r}"`);
          await client.query(`DROP ROLE IF EXISTS "${r}"`);
        }
      } finally {
        await client.end();
      }
    } catch (err) {
      console.warn(`row-security-commands: role teardown failed: ${String(err)}`);
    }
    await db.cleanup();
  });

  it('counts FOR ALL for every command', async () => {
    expect((await rlsOf('all_commands')).deniedCommands).toEqual([]);
    // And the database agrees: the insert a per-command count would have
    // predicted to fail actually succeeds.
    expect(await asRole(`INSERT INTO all_commands VALUES (1, 'a')`)).toEqual({ rowCount: 1 });
  });

  it('names the commands a FOR SELECT-only policy leaves without one', async () => {
    expect((await rlsOf('select_only')).deniedCommands).toEqual(['insert', 'update', 'delete']);
    // Each one is refused for real, with every privilege granted — and the two
    // shapes of refusal are both here. The INSERT raises; the UPDATE and the
    // DELETE touch nothing while reporting success, which is exactly the
    // outcome a caller cannot distinguish from "there was nothing to change".
    expect((await asRole(`INSERT INTO select_only VALUES (2, 'a')`)).code).toBe('42501');
    expect(await asRole(`UPDATE select_only SET tenant = 'b'`)).toEqual({ rowCount: 0 });
    expect(await asRole(`DELETE FROM select_only`)).toEqual({ rowCount: 0 });
    // The INSERT raises per row written, so one that writes no row is not
    // refused at all — it reports success, which puts it on the silent side of
    // the line with UPDATE and DELETE. This is why the advisory says "once it
    // writes a row" rather than "a refused INSERT raises".
    expect(await asRole(`INSERT INTO select_only SELECT 3, 'a' WHERE false`)).toEqual({
      rowCount: 0,
    });
    // SELECT is not in the list, and it reads the seeded row.
    expect(await asRole(`SELECT * FROM select_only`)).toEqual({ rowCount: 1 });
  });

  it('does not promise a command it leaves off the list', async () => {
    // The only policy is FOR INSERT, so insert has a permissive policy and is
    // absent from the list — and the prober's INSERT is refused all the same,
    // because the policy names another role and `polroles` is deliberately not
    // read. Unlisted means "not derivably refused", never "allowed".
    expect((await rlsOf('insert_other_role')).deniedCommands).toEqual([
      'select',
      'update',
      'delete',
    ]);
    expect((await asRole(`INSERT INTO insert_other_role VALUES (1, 'a')`)).code).toBe('42501');
  });

  it('does not count a restrictive policy as granting its command', async () => {
    const rls = await rlsOf('restrictive_only');
    // A policy exists — but it grants nothing, so every command is refused.
    expect(rls.hasPolicies).toBe(true);
    expect(rls.deniedCommands).toEqual(['select', 'insert', 'update', 'delete']);
    expect((await asRole(`INSERT INTO restrictive_only VALUES (2, 'a')`)).code).toBe('42501');
    // The seeded row exists and is invisible: a restrictive policy grants no
    // read either.
    expect(await asRole(`SELECT * FROM restrictive_only`)).toEqual({ rowCount: 0 });
  });

  it('adds no field beyond the four the signal is made of', async () => {
    const r = await run();
    // Named rather than counted: a loop over zero tables would assert nothing,
    // and this also catches a fixture table quietly going missing.
    expect(r.tables.map((t) => t.name).sort()).toEqual([
      'all_commands',
      'insert_other_role',
      'restrictive_only',
      'select_only',
    ]);
    for (const table of r.tables) {
      // A shape assertion rather than a search for expression text: the policy
      // bodies here are `true`, which no substring check could distinguish from
      // JSON's own booleans. What a leak would look like at this layer is a
      // fifth key, and the canary suite in `kozou` covers the text itself.
      expect(Object.keys(table.rowSecurity!).sort()).toEqual([
        'deniedCommands',
        'enabled',
        'forced',
        'hasPolicies',
      ]);
    }
  });
});

// The derivation itself, without a database: the cases above pin it to
// PostgreSQL's behaviour, these pin every branch cheaply.
describe('deniedCommands', () => {
  it('is empty while RLS is off, whatever policies exist', () => {
    expect(deniedCommands(false, ['r'])).toEqual([]);
    expect(deniedCommands(false, [])).toEqual([]);
  });

  it('is every command when RLS is on with no permissive policy', () => {
    expect(deniedCommands(true, [])).toEqual(['select', 'insert', 'update', 'delete']);
  });

  it("treats '*' as covering everything", () => {
    expect(deniedCommands(true, ['*'])).toEqual([]);
    expect(deniedCommands(true, ['*', 'r'])).toEqual([]);
  });

  it('subtracts exactly the commands with a permissive policy', () => {
    expect(deniedCommands(true, ['r'])).toEqual(['insert', 'update', 'delete']);
    expect(deniedCommands(true, ['a'])).toEqual(['select', 'update', 'delete']);
    expect(deniedCommands(true, ['w'])).toEqual(['select', 'insert', 'delete']);
    expect(deniedCommands(true, ['d'])).toEqual(['select', 'insert', 'update']);
    expect(deniedCommands(true, ['r', 'a', 'w', 'd'])).toEqual([]);
  });

  it('ignores a code it does not know rather than treating it as coverage', () => {
    // A future polcmd value must not silently mean "everything is allowed".
    expect(deniedCommands(true, ['z'])).toEqual(['select', 'insert', 'update', 'delete']);
  });
});
