// Verifies the pre-registered ground truths: every task's canonical SQL,
// executed against the generated fixture AT EVERY SCALE, must produce the
// expected score. This is what makes the task set trustworthy — the expected
// values are CI-checked derivations of the seed, not hand-maintained
// constants, and they must hold identically at S/M/L (core is scale-invariant).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { setupDatabase, type DatabaseHandle } from '@kozou/test-utils';

import { loadFixture } from '../src/fixture.js';
import { executeTaskSql, scoreRows } from '../src/score.js';
import { loadTasks, loadGateTasks } from '../src/tasks.js';
import { SCALES, type Scale } from '../src/schema/generate.js';

const tasks = loadTasks();
const gateTasks = loadGateTasks();

describe('task set shape', () => {
  it('has at least 16 core tasks with unique ids', () => {
    expect(tasks.length).toBeGreaterThanOrEqual(16);
    expect(new Set(tasks.map((t) => t.id)).size).toBe(tasks.length);
  });

  it('has enough strong-trap tasks for a leak-gate denominator', () => {
    expect(tasks.filter((t) => t.strong_trap).length).toBeGreaterThanOrEqual(10);
  });

  it('covers every difficulty tier and control tasks', () => {
    for (const tier of ['D1', 'D2', 'D3']) {
      expect(tasks.some((t) => t.difficulty === tier)).toBe(true);
    }
    expect(tasks.some((t) => t.category === 'control' && !t.strong_trap)).toBe(true);
  });
});

describe('ground truths at every scale', () => {
  let db: DatabaseHandle;
  let client: pg.Client;
  const schemaFor: Record<Scale, string> = { S: '', M: '', L: '' };

  beforeAll(async () => {
    db = await setupDatabase();
    client = new pg.Client({ connectionString: db.connectionString });
    await client.connect();
    for (const scale of SCALES) {
      const schema = `${db.schema}_${scale.toLowerCase()}`;
      schemaFor[scale] = schema;
      await loadFixture(client, schema, scale);
    }
  });

  afterAll(async () => {
    await client?.end();
    await db?.cleanup();
  });

  for (const scale of SCALES) {
    describe(`scale ${scale}`, () => {
      it.each(tasks.map((t) => [t.id, t] as const))(
        '%s canonical SQL matches expected',
        async (_id, task) => {
          await client.query(`SET search_path TO "${schemaFor[scale]}"`);
          const exec = await executeTaskSql(client, task.canonical_sql);
          expect(exec.error, `${task.id}@${scale}: ${exec.error}`).toBeUndefined();
          expect(exec.ok).toBe(true);
          const score = scoreRows(task.scoring, exec.rows);
          expect(score.correct, `${task.id}@${scale}: ${score.detail} (${score.observed})`).toBe(true);
          if (task.scoring.kind === 'numeric') {
            // Exact hit, not merely within tolerance — ground truth is exact.
            expect(score.errorRatio).toBeCloseTo(1, 6);
          }
        },
      );

      it.each(gateTasks.map((t) => [t.id, t] as const))(
        'gate %s canonical SQL matches expected',
        async (_id, task) => {
          await client.query(`SET search_path TO "${schemaFor[scale]}"`);
          const exec = await executeTaskSql(client, task.canonical_sql);
          expect(exec.error, `${task.id}@${scale}: ${exec.error}`).toBeUndefined();
          const score = scoreRows(task.scoring, exec.rows);
          expect(score.correct, `${task.id}@${scale}: ${score.detail} (${score.observed})`).toBe(true);
        },
      );
    });
  }
});
