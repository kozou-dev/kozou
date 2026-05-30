import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pkg from 'pg';
import {
  setupDatabase,
  type DatabaseHandle,
  GENERIC_FIXTURE_SQL,
} from '@kozou/test-utils';
import {
  SchemaCache,
  listTables,
  describeTable,
  listViews,
  describeView,
  listConcepts,
  getConceptContext,
} from '../src/index.js';

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
      await client.query(GENERIC_FIXTURE_SQL);
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
  });

  it('get_concept_context: exampleQueries surfaces the @example: block on the VIEW comment', async () => {
    const ctx = await cache.get();
    const r = getConceptContext({ name: 'vw_inventory_for_sale' }, ctx);
    expect(r.exampleQueries).toEqual([
      {
        description: 'Items currently for sale, by author',
        sql:
          'SELECT author_name, book_title, selling_price\n' +
          'FROM vw_inventory_for_sale\n' +
          'ORDER BY author_name, book_title;',
      },
    ]);
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
