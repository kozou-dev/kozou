// Verifies the pre-registered ground truths: every task's canonical SQL,
// executed against the live quickstart fixture, must produce the expected
// score. This is what makes taskset.yaml trustworthy — the expected values
// are not hand-maintained constants but CI-checked derivations of the seed.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { setupDatabase, type DatabaseHandle } from '@kozou/test-utils';

import { loadFixtureSql } from '../src/fixture.js';
import { executeTaskSql, scoreRows } from '../src/score.js';
import { loadTasks } from '../src/tasks.js';

const tasks = loadTasks();

describe('taskset ground truths', () => {
  let db: DatabaseHandle;
  let client: pg.Client;

  beforeAll(async () => {
    db = await setupDatabase();
    client = new pg.Client({ connectionString: db.connectionString });
    await client.connect();
    await client.query(`CREATE SCHEMA "${db.schema}"`);
    await client.query(`SET search_path TO "${db.schema}"`);
    await client.query(loadFixtureSql(db.schema));
  });

  afterAll(async () => {
    await client?.end();
    await db?.cleanup();
  });

  it('has the pre-registered task count and unique ids', () => {
    expect(tasks).toHaveLength(12);
    expect(new Set(tasks.map((t) => t.id)).size).toBe(12);
  });

  it.each(tasks.map((task) => [task.id, task] as const))(
    '%s: canonical SQL matches the expected ground truth',
    async (_id, task) => {
      const execution = await executeTaskSql(client, task.canonical_sql);
      expect(execution.error).toBeUndefined();
      expect(execution.ok).toBe(true);
      const score = scoreRows(task.scoring, execution.rows);
      expect(score.detail).toContain('matched');
      expect(score.correct).toBe(true);
      if (task.scoring.kind === 'numeric') {
        // The canonical SQL must hit the expected value exactly, not just
        // within tolerance — ground truth is a derivation, not an estimate.
        expect(score.errorRatio === undefined || score.errorRatio === 1).toBe(true);
      }
    },
  );
});
