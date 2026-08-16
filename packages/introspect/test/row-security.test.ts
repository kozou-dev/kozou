import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pkg from 'pg';
import { introspect } from '../src/index.js';
import { setupDatabase, type DatabaseHandle } from '@kozou/test-utils';

// Row-level security signal: introspection reads a table's
// `relrowsecurity` / `relforcerowsecurity` and whether any policy exists, so an
// AI agent can be told the rows it sees may be filtered. The policy expressions
// (USING / WITH CHECK) are deliberately never read — only their existence.
const FIXTURE_SQL = `
  -- A plain table with no RLS.
  CREATE TABLE plain (id uuid PRIMARY KEY, name text);

  -- RLS enabled with a policy: rows are filtered for non-owner roles.
  CREATE TABLE tenant_data (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, body text);
  ALTER TABLE tenant_data ENABLE ROW LEVEL SECURITY;
  CREATE POLICY tenant_isolation ON tenant_data
    USING (tenant_id = current_setting('app.tenant', true)::uuid);

  -- RLS enabled with NO policy: effectively default-deny for non-owner roles.
  CREATE TABLE locked (id uuid PRIMARY KEY, secret text);
  ALTER TABLE locked ENABLE ROW LEVEL SECURITY;

  -- RLS enabled + FORCE + a policy: applies to the table owner too.
  CREATE TABLE forced_tbl (id uuid PRIMARY KEY, owner_id uuid);
  ALTER TABLE forced_tbl ENABLE ROW LEVEL SECURITY;
  ALTER TABLE forced_tbl FORCE ROW LEVEL SECURITY;
  CREATE POLICY owner_only ON forced_tbl USING (true);
`;

describe('introspect: row-level security signal', () => {
  let db: DatabaseHandle;

  beforeAll(async () => {
    db = await setupDatabase();
    const client = new pkg.Client({ connectionString: db.connectionString });
    await client.connect();
    try {
      await client.query(`CREATE SCHEMA "${db.schema}"`);
      await client.query(`SET search_path TO "${db.schema}"`);
      await client.query(FIXTURE_SQL);
    } finally {
      await client.end();
    }
  }, 120_000);

  afterAll(async () => {
    if (db) await db.cleanup();
  });

  const run = () => introspect({ connection: db.connectionString, schemas: [db.schema] });
  const tableOf = (r: Awaited<ReturnType<typeof run>>, name: string) =>
    r.tables.find((t) => t.name === name)!;

  it('reports RLS off for a plain table', async () => {
    const r = await run();
    expect(tableOf(r, 'plain').rowSecurity).toEqual({
      enabled: false,
      forced: false,
      hasPolicies: false,
      // RLS is off, so it refuses nothing — an empty list, not "all four".
      deniedCommands: [],
    });
  });

  it('reports RLS enabled with a policy', async () => {
    const r = await run();
    expect(tableOf(r, 'tenant_data').rowSecurity).toEqual({
      enabled: true,
      forced: false,
      hasPolicies: true,
      // The policy has no FOR clause, so it is FOR ALL.
      deniedCommands: [],
    });
  });

  it('reports RLS enabled with no policy (default-deny)', async () => {
    const r = await run();
    expect(tableOf(r, 'locked').rowSecurity).toEqual({
      enabled: true,
      forced: false,
      hasPolicies: false,
      deniedCommands: ['select', 'insert', 'update', 'delete'],
    });
  });

  it('reports forced RLS', async () => {
    const r = await run();
    expect(tableOf(r, 'forced_tbl').rowSecurity).toEqual({
      enabled: true,
      forced: true,
      hasPolicies: true,
      deniedCommands: [],
    });
  });

  it('never carries a policy expression on the raw table', async () => {
    const r = await run();
    // The signal is booleans only; assert the introspected shape exposes no
    // expression text from pg_policy (USING / WITH CHECK are never read).
    const serialized = JSON.stringify(tableOf(r, 'tenant_data').rowSecurity);
    expect(serialized).not.toContain('tenant_id');
    expect(serialized).not.toContain('current_setting');
  });
});
