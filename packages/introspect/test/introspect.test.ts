import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pkg from 'pg';
import { setupDatabase, type DatabaseHandle } from './setup.js';
import { introspect } from '../src/index.js';

// Inline self-contained SQL fixture for this integration test. Keeps the
// suite independent of any external sample SQL.
const FIXTURE_SQL = `
CREATE TABLE authors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name text NOT NULL,
  deleted_at timestamptz
);
COMMENT ON TABLE authors IS 'Authors of books.';
COMMENT ON COLUMN authors.display_name IS 'Display name of the author.';

CREATE TABLE books (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id uuid NOT NULL REFERENCES authors(id),
  title text NOT NULL,
  deleted_at timestamptz
);
COMMENT ON TABLE books IS 'Books authored by an author.';
COMMENT ON COLUMN books.author_id IS 'Reference to the author.';

CREATE TABLE editions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id uuid NOT NULL REFERENCES books(id),
  isbn text UNIQUE,
  deleted_at timestamptz
);
COMMENT ON TABLE editions IS 'Editions of a book.';

CREATE TABLE inventory_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  edition_id uuid NOT NULL REFERENCES editions(id),
  status text NOT NULL CHECK (status IN ('for_sale', 'reserved', 'sold')),
  selling_price numeric(12, 2),
  visibility text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'private')),
  deleted_at timestamptz
);
COMMENT ON TABLE inventory_items IS 'Inventory items available for sale.
@ai: prefer vw_inventory_for_sale when querying active stock.';
COMMENT ON COLUMN inventory_items.status IS 'Current state of the item.
@widget: enum-select';
COMMENT ON COLUMN inventory_items.selling_price IS 'Actual selling price.
@widget: currency';

CREATE VIEW vw_inventory_for_sale AS
  SELECT i.id, i.edition_id, i.selling_price, e.book_id, b.title AS book_title, b.author_id, a.display_name AS author_name
  FROM inventory_items i
  JOIN editions e ON e.id = i.edition_id AND e.deleted_at IS NULL
  JOIN books b ON b.id = e.book_id AND b.deleted_at IS NULL
  JOIN authors a ON a.id = b.author_id AND a.deleted_at IS NULL
  WHERE i.status = 'for_sale' AND i.deleted_at IS NULL AND i.visibility = 'public';
COMMENT ON VIEW vw_inventory_for_sale IS 'Inventory items currently available for sale.
@ai: start from this VIEW for stock-related queries; no need to re-JOIN.';
`;

describe('introspect (generic English fixture)', () => {
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
