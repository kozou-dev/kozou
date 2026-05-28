import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pkg from 'pg';
import { setupDatabase, type DatabaseHandle } from './setup.js';
import {
  SchemaCache,
  listTables,
  describeTable,
  listViews,
  describeView,
  listConcepts,
  getConceptContext,
} from '../src/index.js';

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

describe('MCP tools (generic English fixture, Kozou v0.1 spec §13.2)', () => {
  let db: DatabaseHandle;
  let cache: SchemaCache;

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
    cache = new SchemaCache({
      connection: db.connectionString,
      schemas: [db.schema],
      ttlMs: 60_000,
    });
  }, 120_000);

  afterAll(async () => {
    if (db) await db.cleanup();
  });

  it('list_tables: returns 4 tables', async () => {
    const ctx = await cache.get();
    const r = listTables({ schema: db.schema }, ctx);
    expect(r.tables.map((t) => t.qualifiedName).sort()).toEqual([
      `${db.schema}.authors`,
      `${db.schema}.books`,
      `${db.schema}.editions`,
      `${db.schema}.inventory_items`,
    ]);
    // rowCountEstimate is either null (never analyzed) or a non-negative
    // integer. The cache fixture inserts no rows and does not run
    // ANALYZE, so PostgreSQL may leave reltuples at -1 (mapped to null)
    // or autovacuum may bump it to 0 between fixture load and the
    // introspect query. The dedicated `reflects analyzed table
    // cardinality` test below covers the analyzed-with-rows path.
    for (const t of r.tables) {
      expect(t.rowCountEstimate === null || t.rowCountEstimate >= 0).toBe(true);
    }
  });

  it('list_tables: rowCountEstimate reflects analyzed table cardinality', async () => {
    const client = new pkg.Client({ connectionString: db.connectionString });
    await client.connect();
    try {
      await client.query(`SET search_path TO "${db.schema}"`);
      await client.query(
        `INSERT INTO authors (display_name) VALUES ('A'), ('B'), ('C')`,
      );
      await client.query(`ANALYZE "${db.schema}".authors`);
    } finally {
      await client.end();
    }

    // Fresh cache so the next introspect call re-runs against the now-
    // analyzed table.
    const freshCache = new SchemaCache({
      connection: db.connectionString,
      schemas: [db.schema],
      ttlMs: 60_000,
    });
    const ctx = await freshCache.get();
    const r = listTables({ schema: db.schema }, ctx);

    const authors = r.tables.find(
      (t) => t.qualifiedName === `${db.schema}.authors`,
    );
    expect(authors).toBeDefined();
    expect(typeof authors!.rowCountEstimate).toBe('number');
    expect(authors!.rowCountEstimate).toBeGreaterThanOrEqual(3);
  });

  it('list_tables: empty when targeting a different schema', async () => {
    const ctx = await cache.get();
    const r = listTables({ schema: 'public' }, ctx);
    expect(r.tables).toEqual([]);
  });

  it('describe_table: inventory_items columns + checkConstraints + references', async () => {
    const ctx = await cache.get();
    const r = describeTable({ qualifiedName: `${db.schema}.inventory_items` }, ctx);
    expect(r.primaryKey).toEqual(['id']);
    const status = r.columns.find((c) => c.name === 'status');
    expect(status).toBeDefined();
    expect(status!.enumValues?.sort()).toEqual(['for_sale', 'reserved', 'sold']);
    const editionId = r.columns.find((c) => c.name === 'edition_id');
    expect(editionId!.isForeignKey).toBe(true);
    expect(editionId!.references).toEqual({
      table: `${db.schema}.editions`,
      column: 'id',
    });
    expect(r.checkConstraints.length).toBeGreaterThan(0);
    expect(r.checkConstraints.some((c) => /for_sale/.test(c.expression))).toBe(true);
  });

  it('describe_table: throws for unknown table', async () => {
    const ctx = await cache.get();
    expect(() =>
      describeTable({ qualifiedName: `${db.schema}.nonexistent` }, ctx),
    ).toThrow(/Table not found/);
  });

  it('list_views: returns 1 view', async () => {
    const ctx = await cache.get();
    const r = listViews({ schema: db.schema }, ctx);
    expect(r.views.map((v) => v.qualifiedName).sort()).toEqual([
      `${db.schema}.vw_inventory_for_sale`,
    ]);
  });

  it('describe_view: vw_inventory_for_sale underlyingTables + definition', async () => {
    const ctx = await cache.get();
    const r = describeView({ qualifiedName: `${db.schema}.vw_inventory_for_sale` }, ctx);
    expect(r.underlyingTables.sort()).toEqual([
      `${db.schema}.authors`,
      `${db.schema}.books`,
      `${db.schema}.editions`,
      `${db.schema}.inventory_items`,
    ]);
    expect(r.definition).toMatch(/SELECT/i);
    expect(r.definition).toMatch(/inventory_items/);
  });

  it('describe_view: throws for unknown view', async () => {
    const ctx = await cache.get();
    expect(() =>
      describeView({ qualifiedName: `${db.schema}.nonexistent` }, ctx),
    ).toThrow(/View not found/);
  });

  it('list_concepts: returns 1 concept with kind = VIEW', async () => {
    const ctx = await cache.get();
    const r = listConcepts({}, ctx);
    expect(r.concepts).toHaveLength(1);
    expect(r.concepts.every((c) => c.kind === 'VIEW')).toBe(true);
  });

  it('get_concept_context: vw_inventory_for_sale aiNotes / preferredQuerySource / relatedTables', async () => {
    const ctx = await cache.get();
    const r = getConceptContext({ name: 'vw_inventory_for_sale' }, ctx);
    expect(r.name).toBe('vw_inventory_for_sale');
    expect(r.preferredQuerySource).toBe('FROM vw_inventory_for_sale');
    expect(r.aiNotes.length).toBeGreaterThan(0);
    expect(r.relatedTables.length).toBe(4);
    expect(r.exampleQueries).toEqual([]);
  });

  it('get_concept_context: throws for unknown concept', async () => {
    const ctx = await cache.get();
    expect(() => getConceptContext({ name: 'nonexistent' }, ctx)).toThrow(
      /Concept not found/,
    );
  });

  // docs/security.md threat-model fixed test: COMMENT-derived strings are
  // included verbatim in MCP output (trust boundary). The schema author is
  // treated as inside the v0.1 trust boundary; this test catches regressions
  // if a future change starts sanitising the @ai tag output.
  it('threat model: @ai tag content appears verbatim in aiDescription / aiNotes', async () => {
    const ctx = await cache.get();

    const inv = describeTable({ qualifiedName: `${db.schema}.inventory_items` }, ctx);
    expect(inv.aiDescription).toMatch(/prefer vw_inventory_for_sale/);

    const concept = getConceptContext({ name: 'vw_inventory_for_sale' }, ctx);
    expect(concept.aiNotes.some((n) => /start from this VIEW/i.test(n))).toBe(true);
  });
});
