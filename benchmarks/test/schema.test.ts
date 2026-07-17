// Schema-generator invariants (no paid API; needs Docker or
// KOZOU_TEST_DATABASE_URL for the load check).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { setupDatabase, type DatabaseHandle } from '@kozou/test-utils';

import { Mangler } from '../src/schema/mangle.js';
import { buildCoreDomain } from '../src/schema/domain.js';
import { generateSchema, SCALES, NOISE_COUNTS } from '../src/schema/generate.js';
import { loadFixture } from '../src/fixture.js';

// Words that must NOT appear in anything arm A can see (names + view defs).
// Meaning lives only in comments; a naive agent must not recover it from the
// DDL surface. (Case-insensitive substring check.)
const FORBIDDEN = [
  'revenue', 'customer', 'order', 'product', 'price', 'delete', 'status',
  'test', 'paid', 'refund', 'chargeback', 'cart', 'pending', 'active',
  'soft', 'recogni', 'amount', 'discount', 'quantity', 'channel', 'email',
  'country', 'invoice', 'sale',
];

function assertOpaque(label: string, text: string): void {
  const lower = text.toLowerCase();
  for (const w of FORBIDDEN) {
    expect(lower.includes(w), `${label} leaks "${w}": ${text}`).toBe(false);
  }
}

describe('mangler', () => {
  it('is deterministic for a fixed seed', () => {
    const a = new Mangler('seed-x');
    const b = new Mangler('seed-x');
    expect(a.name('table', 'rel', 'k')).toBe(b.name('table', 'rel', 'k'));
  });

  it('dedupes collisions within a namespace', () => {
    const m = new Mangler('seed-y');
    const names = new Set<string>();
    for (let i = 0; i < 50; i += 1) names.add(m.name('column', 'ns', `k${i}`));
    expect(names.size).toBe(50);
  });
});

describe('generated schema', () => {
  it('produces stable output for a fixed seed+scale', () => {
    expect(generateSchema('S').sql).toBe(generateSchema('S').sql);
  });

  it('keeps CORE names identical across scales (same canonical_sql works everywhere)', () => {
    const s = generateSchema('S').legend;
    const m = generateSchema('M').legend;
    const l = generateSchema('L').legend;
    expect(m).toEqual(s);
    expect(l).toEqual(s);
    // Core has 4 tables + 2 views; legend has t:/v:/c: entries.
    expect(Object.keys(s).filter((k) => k.startsWith('t:')).length).toBe(4);
    expect(Object.keys(s).filter((k) => k.startsWith('v:')).length).toBe(2);
  });

  it('respects the pre-registered scale bands', () => {
    expect(generateSchema('S').relationCount).toBeLessThanOrEqual(20);
    expect(generateSchema('M').relationCount).toBeLessThanOrEqual(80);
    expect(generateSchema('L').relationCount).toBeGreaterThanOrEqual(200);
    expect(generateSchema('S').noiseTableCount).toBe(NOISE_COUNTS.S);
  });

  it('does not leak business meaning into names or view definitions', () => {
    const mangler = new Mangler('c10-v1');
    const core = buildCoreDomain(mangler);
    for (const t of core.tables) {
      assertOpaque('table name', t.name);
      for (const c of t.columns) assertOpaque('column name', c.name);
    }
    for (const v of core.views) {
      assertOpaque('view name', v.name);
      assertOpaque('view definition', v.definition);
    }
  });
});

describe('generated schema loads and is queryable as analyst', () => {
  let db: DatabaseHandle;
  let client: pg.Client;

  beforeAll(async () => {
    db = await setupDatabase();
    client = new pg.Client({ connectionString: db.connectionString });
    await client.connect();
  });

  afterAll(async () => {
    await client?.end();
    await db?.cleanup();
  });

  it.each(SCALES)('loads at scale %s and analyst can read core tables + views', async (scale) => {
    const schema = `${db.schema}_${scale.toLowerCase()}`;
    await loadFixture(client, schema, scale);
    const gen = generateSchema(scale);
    const customer = gen.legend['t:customer'];
    const orderEnriched = gen.legend['v:order_enriched'];

    await client.query('BEGIN READ ONLY');
    await client.query('SET LOCAL ROLE analyst');
    const cust = await client.query(`SELECT count(*)::int AS n FROM "${schema}".${customer}`);
    const view = await client.query(`SELECT count(*)::int AS n FROM "${schema}".${orderEnriched}`);
    await client.query('ROLLBACK');

    expect(cust.rows[0].n).toBe(4); // 4 seeded customers (1 soft-deleted)
    expect(view.rows[0].n).toBe(10); // 10 seeded orders, each joins to a customer
  });
});
