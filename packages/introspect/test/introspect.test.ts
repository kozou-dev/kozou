import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pkg from 'pg';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { setupDatabase, type DatabaseHandle } from './setup.js';
import { introspect } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const nimartSql = readFileSync(
  resolve(here, '../../../examples/nimart/migrations/0001_init.sql'),
  'utf8',
);

describe('introspect (nimart fixture)', () => {
  let db: DatabaseHandle;

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
  }, 120_000);

  afterAll(async () => {
    if (db) await db.cleanup();
  });

  const introspectSuite = () =>
    introspect({ connection: db.connectionString, schemas: [db.schema] });

  it('returns 7 base tables', async () => {
    const r = await introspectSuite();
    expect(r.tables.map((t) => t.name).sort()).toEqual([
      'artists',
      'artworks',
      'code_sets',
      'code_values',
      'editions',
      'images',
      'inventory_items',
    ]);
  });

  it('returns 3 views', async () => {
    const r = await introspectSuite();
    expect(r.views.map((v) => v.name).sort()).toEqual([
      'vw_artist_inventory_summary',
      'vw_artworks_missing_images',
      'vw_inventory_for_sale',
    ]);
  });

  it('extracts COMMENT for table and column (with @widget tag intact)', async () => {
    const r = await introspectSuite();
    const inv = r.tables.find((t) => t.name === 'inventory_items');
    expect(inv).toBeDefined();
    expect(inv!.comment).toMatch(/在庫個体/);
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
    // PG は CHECK (x IN (...)) を pg_get_constraintdef で `x = ANY (ARRAY[...])`
    // に正規化するため、値リテラルでマッチさせる (regex は IN/ANY 両形に堅牢)
    const has = inv!.checks.some(
      (c) => /for_sale/.test(c.expression) && /reserved/.test(c.expression) && /sold/.test(c.expression),
    );
    expect(has).toBe(true);
  });

  it('extracts VIEW underlying tables (vw_inventory_for_sale → 4 tables)', async () => {
    const r = await introspectSuite();
    const v = r.views.find((vw) => vw.name === 'vw_inventory_for_sale');
    expect(v).toBeDefined();
    expect(v!.underlyingTables.map((t) => t.name).sort()).toEqual([
      'artists',
      'artworks',
      'editions',
      'inventory_items',
    ]);
  });

  it('returns empty enums (nimart uses CHECK + code_values, not PG ENUM)', async () => {
    const r = await introspectSuite();
    expect(r.enums).toEqual([]);
  });

  it('returns serverVersion + introspectedAt + schemas', async () => {
    const r = await introspectSuite();
    expect(r.serverVersion).toMatch(/^16\./);
    expect(r.introspectedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(r.schemas).toEqual([db.schema]);
  });
});
