import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pkg from 'pg';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
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

const here = dirname(fileURLToPath(import.meta.url));
const nimartSql = readFileSync(
  resolve(here, '../../../examples/nimart/migrations/0001_init.sql'),
  'utf8',
);

describe('MCP tools (nimart fixture, dev_spec §13.2)', () => {
  let db: DatabaseHandle;
  let cache: SchemaCache;

  beforeAll(async () => {
    db = await setupDatabase();
    const client = new pkg.Client({ connectionString: db.connectionString });
    await client.connect();
    try {
      await client.query(`CREATE SCHEMA "${db.schema}"`);
      await client.query(`SET search_path TO "${db.schema}"`);
      await client.query(nimartSql);
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

  it('list_tables: nimart の 7 tables、rowCountEstimate は null', async () => {
    const ctx = await cache.get();
    const r = listTables({ schema: db.schema }, ctx);
    expect(r.tables.map((t) => t.qualifiedName).sort()).toEqual([
      `${db.schema}.artists`,
      `${db.schema}.artworks`,
      `${db.schema}.code_sets`,
      `${db.schema}.code_values`,
      `${db.schema}.editions`,
      `${db.schema}.images`,
      `${db.schema}.inventory_items`,
    ]);
    for (const t of r.tables) {
      expect(t.rowCountEstimate).toBeNull();
    }
  });

  it('list_tables: schema が違うと空', async () => {
    const ctx = await cache.get();
    const r = listTables({ schema: 'public' }, ctx);
    expect(r.tables).toEqual([]);
  });

  it('describe_table: inventory_items の columns + checkConstraints + references', async () => {
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

  it('describe_table: 存在しない table で throw', async () => {
    const ctx = await cache.get();
    expect(() =>
      describeTable({ qualifiedName: `${db.schema}.nonexistent` }, ctx),
    ).toThrow(/Table not found/);
  });

  it('list_views: 3 views', async () => {
    const ctx = await cache.get();
    const r = listViews({ schema: db.schema }, ctx);
    expect(r.views.map((v) => v.qualifiedName).sort()).toEqual([
      `${db.schema}.vw_artist_inventory_summary`,
      `${db.schema}.vw_artworks_missing_images`,
      `${db.schema}.vw_inventory_for_sale`,
    ]);
  });

  it('describe_view: vw_inventory_for_sale の underlyingTables + definition', async () => {
    const ctx = await cache.get();
    const r = describeView({ qualifiedName: `${db.schema}.vw_inventory_for_sale` }, ctx);
    expect(r.underlyingTables.sort()).toEqual([
      `${db.schema}.artists`,
      `${db.schema}.artworks`,
      `${db.schema}.editions`,
      `${db.schema}.inventory_items`,
    ]);
    expect(r.definition).toMatch(/SELECT/i);
    expect(r.definition).toMatch(/inventory_items/);
  });

  it('describe_view: 存在しない view で throw', async () => {
    const ctx = await cache.get();
    expect(() =>
      describeView({ qualifiedName: `${db.schema}.nonexistent` }, ctx),
    ).toThrow(/View not found/);
  });

  it('list_concepts: 3 concepts、kind は VIEW', async () => {
    const ctx = await cache.get();
    const r = listConcepts({}, ctx);
    expect(r.concepts).toHaveLength(3);
    expect(r.concepts.every((c) => c.kind === 'VIEW')).toBe(true);
  });

  it('get_concept_context: vw_inventory_for_sale の aiNotes / preferredQuerySource / relatedTables', async () => {
    const ctx = await cache.get();
    const r = getConceptContext({ name: 'vw_inventory_for_sale' }, ctx);
    expect(r.name).toBe('vw_inventory_for_sale');
    expect(r.preferredQuerySource).toBe('FROM vw_inventory_for_sale');
    expect(r.aiNotes.length).toBeGreaterThan(0);
    expect(r.relatedTables.length).toBe(4);
    expect(r.exampleQueries).toEqual([]);
  });

  it('get_concept_context: 存在しない concept で throw', async () => {
    const ctx = await cache.get();
    expect(() => getConceptContext({ name: 'nonexistent' }, ctx)).toThrow(
      /Concept not found/,
    );
  });
});
