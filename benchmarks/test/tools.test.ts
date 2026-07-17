// Arm A/B tool backends (no paid API): A hides comments, B shows them and can
// search; both expose relation structure and view definitions.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { setupDatabase, type DatabaseHandle } from '@kozou/test-utils';

import { loadFixture } from '../src/fixture.js';
import { createCatalogProvider } from '../src/tools/provider.js';
import { generateSchema } from '../src/schema/generate.js';

const legend = generateSchema('S').legend;
const ORDER = legend['t:order'];
const ORDER_ENRICHED = legend['v:order_enriched'];

describe('catalog tool providers', () => {
  let db: DatabaseHandle;
  let client: pg.Client;
  let schema: string;

  beforeAll(async () => {
    db = await setupDatabase();
    client = new pg.Client({ connectionString: db.connectionString });
    await client.connect();
    schema = db.schema;
    await loadFixture(client, schema, 'S');
  });

  afterAll(async () => {
    await client?.end();
    await db?.cleanup();
  });

  it('A exposes 4 tools and NO search_comments', () => {
    const a = createCatalogProvider(client, schema, false);
    expect(a.tools.map((t) => t.name).sort()).toEqual(
      ['describe_table', 'describe_view', 'list_tables', 'list_views'].sort(),
    );
  });

  it('B adds search_comments (5 tools)', () => {
    const b = createCatalogProvider(client, schema, true);
    expect(b.tools.map((t) => t.name)).toContain('search_comments');
    expect(b.tools).toHaveLength(5);
  });

  it('list_tables returns the core tables (opaque names)', async () => {
    const a = createCatalogProvider(client, schema, false);
    const out = await a.execute('list_tables', {});
    expect(out).toContain(ORDER);
    expect(out.split('\n').length).toBeGreaterThanOrEqual(4);
  });

  it('A describe_table shows structure but NO comment text', async () => {
    const a = createCatalogProvider(client, schema, false);
    const out = await a.execute('describe_table', { name: ORDER });
    expect(out).toContain(ORDER);
    expect(out).not.toContain('COMMENT');
    expect(out.toLowerCase()).not.toContain('deprecated'); // a comment word
    expect(out.toLowerCase()).not.toContain('recognized');
  });

  it('B describe_table includes the verbatim comment', async () => {
    const b = createCatalogProvider(client, schema, true);
    const out = await b.execute('describe_table', { name: ORDER });
    expect(out).toContain('COMMENT');
    expect(out.toLowerCase()).toContain('deprecated'); // amount_total note
  });

  it('B describe_view includes the view definition', async () => {
    const b = createCatalogProvider(client, schema, true);
    const out = await b.execute('describe_view', { name: ORDER_ENRICHED });
    expect(out.toUpperCase()).toContain('VIEW DEFINITION');
  });

  it('B search_comments finds meaning by business term', async () => {
    const b = createCatalogProvider(client, schema, true);
    const revenue = await b.execute('search_comments', { query: 'recognized sale' });
    expect(revenue).toContain(ORDER);
    const softdelete = await b.execute('search_comments', { query: 'soft-deleted' });
    expect(softdelete.toLowerCase()).toContain('soft-deleted');
  });

  it('describe_table returns an actionable error for an unknown relation', async () => {
    const a = createCatalogProvider(client, schema, false);
    await expect(a.execute('describe_table', { name: 'nope_x' })).rejects.toThrow(/not found/);
  });
});
