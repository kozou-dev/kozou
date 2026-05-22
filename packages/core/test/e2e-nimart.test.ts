import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pkg from 'pg';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { introspect } from '@kozou/introspect';
import { setupDatabase, type DatabaseHandle } from './setup.js';
import { buildSchemaContext, loadUIHints } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const nimartSqlPath = resolve(here, '../../../examples/nimart/migrations/0001_init.sql');
const nimartUiHintsPath = resolve(here, '../../../examples/nimart/ui-hints.yaml');
const nimartSql = readFileSync(nimartSqlPath, 'utf8');

describe('E2E nimart (introspect → buildSchemaContext)', () => {
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

  it('introspect → buildSchemaContext で 7 tables + 3 views + 3 concepts', async () => {
    const raw = await introspect({ connection: db.connectionString, schemas: [db.schema] });
    const ctx = await buildSchemaContext({ raw });
    expect(ctx.tables.map((t) => t.name).sort()).toEqual([
      'artists',
      'artworks',
      'code_sets',
      'code_values',
      'editions',
      'images',
      'inventory_items',
    ]);
    expect(ctx.views).toHaveLength(3);
    expect(ctx.concepts).toHaveLength(3);
  });

  it('inventory_items.status の widget = enum-select、enumValues = for_sale/reserved/sold', async () => {
    const raw = await introspect({ connection: db.connectionString, schemas: [db.schema] });
    const ctx = await buildSchemaContext({ raw });
    const inv = ctx.tables.find((t) => t.name === 'inventory_items')!;
    const status = inv.columns.find((c) => c.name === 'status')!;
    expect(status.widget).toBe('enum-select');
    expect(status.enumValues?.sort()).toEqual(['for_sale', 'reserved', 'sold']);
  });

  it('artists.displayField = display_name (heuristic)', async () => {
    const raw = await introspect({ connection: db.connectionString, schemas: [db.schema] });
    const ctx = await buildSchemaContext({ raw });
    const artists = ctx.tables.find((t) => t.name === 'artists')!;
    expect(artists.displayField).toBe('display_name');
  });

  it('UIHints (nimart/ui-hints.yaml) を適用すると label が日本語に', async () => {
    const raw = await introspect({ connection: db.connectionString, schemas: [db.schema] });
    const uiHints = await loadUIHints(nimartUiHintsPath);
    const ctx = await buildSchemaContext({ raw, uiHints });
    expect(ctx.tables.find((t) => t.name === 'artists')!.label).toBe('作家');
    expect(ctx.tables.find((t) => t.name === 'inventory_items')!.label).toBe('在庫個体');
    const sellingPrice = ctx.tables
      .find((t) => t.name === 'inventory_items')!
      .columns.find((c) => c.name === 'selling_price')!;
    expect(sellingPrice.widget).toBe('currency');
  });

  it('vw_inventory_for_sale concept の aiNotes が抽出される', async () => {
    const raw = await introspect({ connection: db.connectionString, schemas: [db.schema] });
    const ctx = await buildSchemaContext({ raw });
    const concept = ctx.concepts.find((c) => c.name === 'vw_inventory_for_sale')!;
    expect(concept.aiNotes.length).toBeGreaterThan(0);
    expect(concept.aiNotes.join('\n')).toMatch(/販売可能/);
  });

  it('vw_inventory_for_sale concept.joinSuggestions に 4 underlying tables 全て', async () => {
    const raw = await introspect({ connection: db.connectionString, schemas: [db.schema] });
    const ctx = await buildSchemaContext({ raw });
    const concept = ctx.concepts.find((c) => c.name === 'vw_inventory_for_sale')!;
    const tableNames = concept.joinSuggestions.map((j) => j.table.split('.')[1]!).sort();
    expect(tableNames).toEqual(['artists', 'artworks', 'editions', 'inventory_items']);
  });

  it('artworks.artist_id は relation-select widget + RelationContext', async () => {
    const raw = await introspect({ connection: db.connectionString, schemas: [db.schema] });
    const ctx = await buildSchemaContext({ raw });
    const artworks = ctx.tables.find((t) => t.name === 'artworks')!;
    const artistId = artworks.columns.find((c) => c.name === 'artist_id')!;
    expect(artistId.widget).toBe('relation-select');
    expect(artistId.isForeignKey).toBe(true);
    const rel = artworks.relations.find((r) => r.field === 'artist_id')!;
    expect(rel.references.table).toBe('artists');
  });
});
