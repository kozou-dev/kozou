import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { performance } from 'node:perf_hooks';
import pkg from 'pg';
import { setupDatabase, type DatabaseHandle } from '@kozou/test-utils';
import { introspect } from '../src/index.js';

// Performance requirement: introspecting a
// 100-table / 1000-column schema must complete within 3s (localhost, no
// network latency). This gate generates exactly that shape (100 tables x
// 10 columns = 1000 columns) and asserts the introspect() call stays
// under budget.
//
// The container start + DDL creation happen in beforeAll and are NOT part
// of the measured window — only the introspect() call is timed, matching
// the spec's "introspect completion" wording. One warm-up call precedes
// the measured run so the timing reflects steady state rather than a cold
// connection.

const TABLE_COUNT = 100;
const COLUMNS_PER_TABLE = 10; // 100 x 10 = 1000 columns total
const TOTAL_COLUMNS = TABLE_COUNT * COLUMNS_PER_TABLE;
const BUDGET_MS = 3_000;

function buildSchemaSql(): string {
  const statements: string[] = [];
  for (let t = 0; t < TABLE_COUNT; t++) {
    const columns = ['id uuid PRIMARY KEY DEFAULT gen_random_uuid()'];
    // 9 more columns -> 10 total per table.
    for (let c = 1; c < COLUMNS_PER_TABLE; c++) {
      columns.push(`col_${c} text`);
    }
    statements.push(`CREATE TABLE t_${t} (\n  ${columns.join(',\n  ')}\n);`);
  }
  return statements.join('\n');
}

describe('introspect performance (100 tables / 1000 columns < 3s)', () => {
  let db: DatabaseHandle;

  beforeAll(async () => {
    db = await setupDatabase();
    const client = new pkg.Client({ connectionString: db.connectionString });
    await client.connect();
    try {
      await client.query(`CREATE SCHEMA "${db.schema}"`);
      await client.query(`SET search_path TO "${db.schema}"`);
      await client.query(buildSchemaSql());
    } finally {
      await client.end();
    }
  }, 120_000);

  afterAll(async () => {
    if (db) await db.cleanup();
  });

  it('introspects 100 tables / 1000 columns within the 3s budget', async () => {
    // Warm-up: discard the first run so the measured run is not skewed by
    // cold-connection / first-query overhead.
    await introspect({ connection: db.connectionString, schemas: [db.schema] });

    const start = performance.now();
    const result = await introspect({
      connection: db.connectionString,
      schemas: [db.schema],
    });
    const elapsedMs = performance.now() - start;

    // Confirm the generated shape really is 100 tables x 1000 columns, so
    // the timing is measured against the intended workload.
    expect(result.tables).toHaveLength(TABLE_COUNT);
    const totalColumns = result.tables.reduce((n, t) => n + t.columns.length, 0);
    expect(totalColumns).toBe(TOTAL_COLUMNS);

    // Surface the measurement so regressions are visible in CI logs.
    console.log(
      `[perf] introspect ${TABLE_COUNT} tables / ${totalColumns} columns: ` +
        `${elapsedMs.toFixed(0)}ms (budget ${BUDGET_MS}ms)`,
    );

    // The gate.
    expect(elapsedMs).toBeLessThan(BUDGET_MS);
  });
});
