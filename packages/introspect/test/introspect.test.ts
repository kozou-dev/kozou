import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pkg from 'pg';
import { introspect, KozouIntrospectError } from '../src/index.js';
import {
  setupDatabase,
  type DatabaseHandle,
  GENERIC_FIXTURE_SQL,
} from '@kozou/test-utils';

describe('introspect (generic English fixture)', () => {
  let db: DatabaseHandle;

  beforeAll(async () => {
    db = await setupDatabase();
    const client = new pkg.Client({ connectionString: db.connectionString });
    await client.connect();
    try {
      await client.query(`CREATE SCHEMA "${db.schema}"`);
      await client.query(`SET search_path TO "${db.schema}"`);
      await client.query(GENERIC_FIXTURE_SQL);
    } finally {
      await client.end();
    }
  }, 120_000);

  afterAll(async () => {
    if (db) await db.cleanup();
  });

  const introspectSuite = () =>
    introspect({ connection: db.connectionString, schemas: [db.schema] });

  it('returns 4 base tables', async () => {
    const r = await introspectSuite();
    expect(r.tables.map((t) => t.name).sort()).toEqual([
      'authors',
      'books',
      'editions',
      'inventory_items',
    ]);
  });

  it('returns 1 view', async () => {
    const r = await introspectSuite();
    expect(r.views.map((v) => v.name).sort()).toEqual(['vw_inventory_for_sale']);
  });

  it('extracts COMMENT for table and column (with @widget tag intact)', async () => {
    const r = await introspectSuite();
    const inv = r.tables.find((t) => t.name === 'inventory_items');
    expect(inv).toBeDefined();
    expect(inv!.comment).toMatch(/Inventory items available for sale/);
    const status = inv!.columns.find((c) => c.name === 'status');
    expect(status).toBeDefined();
    expect(status!.comment).toMatch(/@widget: enum-select/);
  });

  it('extracts FK with referenced table + columns + action', async () => {
    const r = await introspectSuite();
    const inv = r.tables.find((t) => t.name === 'inventory_items');
    expect(inv).toBeDefined();
    const fk = inv!.foreignKeys.find((f) => f.columns.includes('edition_id'));
    expect(fk).toBeDefined();
    expect(fk!.referencedTable).toBe('editions');
    expect(fk!.referencedColumns).toEqual(['id']);
    expect(fk!.onDelete).toBe('NO ACTION');
  });

  it('extracts CHECK expression listing for_sale/reserved/sold', async () => {
    const r = await introspectSuite();
    const inv = r.tables.find((t) => t.name === 'inventory_items');
    expect(inv).toBeDefined();
    // PostgreSQL normalises `CHECK (x IN (...))` to `x = ANY (ARRAY[...])`
    // via pg_get_constraintdef. We match by value literals so this assertion
    // is robust to either form (IN / ANY).
    const has = inv!.checks.some(
      (c) => /for_sale/.test(c.expression) && /reserved/.test(c.expression) && /sold/.test(c.expression),
    );
    expect(has).toBe(true);
  });

  it('extracts VIEW underlying tables (vw_inventory_for_sale -> 4 tables)', async () => {
    const r = await introspectSuite();
    const v = r.views.find((vw) => vw.name === 'vw_inventory_for_sale');
    expect(v).toBeDefined();
    expect(v!.underlyingTables.map((t) => t.name).sort()).toEqual([
      'authors',
      'books',
      'editions',
      'inventory_items',
    ]);
  });

  it('returns empty enums (fixture uses CHECK, not PG ENUM)', async () => {
    const r = await introspectSuite();
    expect(r.enums).toEqual([]);
  });

  it('returns serverVersion + introspectedAt + schemas', async () => {
    const r = await introspectSuite();
    expect(r.serverVersion).toMatch(/^16\./);
    expect(r.introspectedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(r.schemas).toEqual([db.schema]);
  });

  it('returns empty (warns, does not throw) for a non-existent schema', async () => {
    // A schema that does not exist must be a warning + empty result, not a
    // failure.
    const r = await introspect({
      connection: db.connectionString,
      schemas: ['kozou_missing_schema'],
    });
    expect(r.tables).toEqual([]);
    expect(r.views).toEqual([]);
    expect(r.schemas).toEqual(['kozou_missing_schema']);
  });

  it('extracts rowCountEstimate from pg_class.reltuples', async () => {
    const r = await introspectSuite();
    // Fixture inserts no rows; PostgreSQL leaves `reltuples` at -1
    // (mapped to null here) until autovacuum or an explicit ANALYZE
    // runs. Either outcome is acceptable - what we care about is that
    // the field is threaded through with the right type.
    for (const t of r.tables) {
      if (t.rowCountEstimate !== null) {
        expect(typeof t.rowCountEstimate).toBe('number');
        expect(t.rowCountEstimate).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('include limits tables to matching patterns (bare name = *.<name>)', async () => {
    const r = await introspect({
      connection: db.connectionString,
      schemas: [db.schema],
      include: ['authors', 'books'],
    });
    expect(r.tables.map((t) => t.name).sort()).toEqual(['authors', 'books']);
  });

  it('exclude drops matching tables and prunes FKs that would dangle', async () => {
    const r = await introspect({
      connection: db.connectionString,
      schemas: [db.schema],
      exclude: ['editions'],
    });
    const names = r.tables.map((t) => t.name).sort();
    expect(names).toEqual(['authors', 'books', 'inventory_items']);
    // `inventory_items.edition_id` references `editions`, which is now
    // filtered out. The FK to it must be pruned to avoid dangling
    // references in downstream consumers.
    const inv = r.tables.find((t) => t.name === 'inventory_items')!;
    expect(inv.foreignKeys.some((fk) => fk.referencedTable === 'editions')).toBe(false);
  });

  it('include applies to views as well', async () => {
    const r = await introspect({
      connection: db.connectionString,
      schemas: [db.schema],
      include: ['authors'],
    });
    expect(r.views).toEqual([]);
  });

  it('rowCountEstimate updates after INSERT + ANALYZE', async () => {
    const client = new pkg.Client({ connectionString: db.connectionString });
    await client.connect();
    try {
      await client.query(`SET search_path TO "${db.schema}"`);
      await client.query(
        `INSERT INTO authors (display_name) VALUES ('A1'), ('A2'), ('A3'), ('A4'), ('A5')`,
      );
      await client.query(`ANALYZE "${db.schema}".authors`);
    } finally {
      await client.end();
    }
    const r = await introspectSuite();
    const authors = r.tables.find((t) => t.name === 'authors');
    expect(authors).toBeDefined();
    expect(typeof authors!.rowCountEstimate).toBe('number');
    expect(authors!.rowCountEstimate).toBeGreaterThanOrEqual(5);
  });
});

describe('introspect privilege-aware (#99)', () => {
  let db: DatabaseHandle;
  const role = 'priv_test_role';

  beforeAll(async () => {
    db = await setupDatabase();
    const client = new pkg.Client({ connectionString: db.connectionString });
    await client.connect();
    try {
      const s = db.schema;
      await client.query(`CREATE SCHEMA "${s}"`);
      await client.query(`SET search_path TO "${s}"`);
      await client.query(GENERIC_FIXTURE_SQL);
      // A non-login role with deliberately uneven grants, so the introspected
      // privileges exercise table-level, column-level, and deny-by-default.
      await client.query(`CREATE ROLE ${role} NOLOGIN`);
      await client.query(`GRANT USAGE ON SCHEMA "${s}" TO ${role}`);
      // authors: full table grants.
      await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON "${s}".authors TO ${role}`);
      // books: read + insert, but no UPDATE (every column non-updatable).
      await client.query(`GRANT SELECT, INSERT ON "${s}".books TO ${role}`);
      // editions: read-only at table level, plus a single column-level UPDATE.
      await client.query(`GRANT SELECT ON "${s}".editions TO ${role}`);
      await client.query(`GRANT UPDATE (isbn) ON "${s}".editions TO ${role}`);
      // inventory_items: no grants at all -> deny-by-default (hidden candidate).
      // A second role with a table grant but NO schema USAGE: the USAGE gate
      // must still treat authors as unreadable.
      await client.query(`CREATE ROLE no_usage_role NOLOGIN`);
      await client.query(`GRANT SELECT ON "${s}".authors TO no_usage_role`);
    } finally {
      await client.end();
    }
  }, 120_000);

  afterAll(async () => {
    if (db) await db.cleanup();
  });

  it('attaches table privileges for the role (table-level grants)', async () => {
    const r = await introspect({
      connection: db.connectionString,
      schemas: [db.schema],
      privilegeRole: role,
    });
    const byName = new Map(r.tables.map((t) => [t.name, t]));
    expect(byName.get('authors')!.privileges).toEqual({
      role,
      select: true,
      insert: true,
      update: true,
      delete: true,
    });
    expect(byName.get('books')!.privileges).toMatchObject({
      select: true,
      insert: true,
      update: false,
      delete: false,
    });
    expect(byName.get('inventory_items')!.privileges).toMatchObject({ select: false });
    // The view carries no grant to the role -> hidden by the same SELECT rule.
    const view = r.views.find((v) => v.name === 'vw_inventory_for_sale');
    expect(view!.privileges).toMatchObject({ select: false });
  });

  it('gates on schema USAGE: a table grant without schema USAGE reads as denied', async () => {
    const r = await introspect({
      connection: db.connectionString,
      schemas: [db.schema],
      privilegeRole: 'no_usage_role',
    });
    // no_usage_role holds SELECT on authors at the table ACL, but lacks USAGE
    // on the schema, so the effective select must be false (not "shown but 403").
    const authors = r.tables.find((t) => t.name === 'authors')!;
    expect(authors.privileges).toMatchObject({ select: false });
  });

  it('attaches column privileges, including a single column-level UPDATE grant', async () => {
    const r = await introspect({
      connection: db.connectionString,
      schemas: [db.schema],
      privilegeRole: role,
    });
    const editions = r.tables.find((t) => t.name === 'editions')!;
    const cols = new Map(editions.columns.map((c) => [c.name, c]));
    // Only `isbn` carries the column-level UPDATE grant.
    expect(cols.get('isbn')!.privileges).toEqual({ insert: false, update: true });
    expect(cols.get('id')!.privileges).toEqual({ insert: false, update: false });

    // books has table-wide INSERT but no UPDATE -> every column insertable, none updatable.
    const books = r.tables.find((t) => t.name === 'books')!;
    for (const c of books.columns) {
      expect(c.privileges).toEqual({ insert: true, update: false });
    }
  });

  it('leaves privileges undefined when privilegeRole is not set (default mode)', async () => {
    const r = await introspect({ connection: db.connectionString, schemas: [db.schema] });
    for (const t of r.tables) {
      expect(t.privileges).toBeUndefined();
      for (const c of t.columns) expect(c.privileges).toBeUndefined();
    }
  });

  it('throws a clear error when the privilege role does not exist', async () => {
    await expect(
      introspect({
        connection: db.connectionString,
        schemas: [db.schema],
        privilegeRole: 'role_that_does_not_exist',
      }),
    ).rejects.toBeInstanceOf(KozouIntrospectError);
  });
});
