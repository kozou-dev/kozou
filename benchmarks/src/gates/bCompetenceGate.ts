// B competence gate (anti-rigging counterpart to the leak gate): is arm B
// actually strong? Run B (the full agentic loop, comments + search) on the
// gate tasks, whose answers are each stated in a single comment. If B cannot
// solve them at the pre-registered rate, its search/comment path is broken and
// C-B would measure "B is weak", not "Kozou compiles meaning". Fail the gate
// and fix the tooling/fixture before the comparison.

import type Anthropic from '@anthropic-ai/sdk';
import type { ClientBase } from 'pg';

import { createCatalogProvider } from '../tools/provider.js';
import { runAgentLoop } from '../agent/loop.js';
import { executeTaskSql, scoreRows } from '../score.js';
import type { GateTask } from '../types.js';

export interface BCompetenceResult {
  pass: boolean;
  threshold: number;
  accuracy: number;
  runs: number;
  perTask: Array<{ id: string; correct: number; runs: number }>;
}

export async function runBCompetenceGate(
  pgClient: ClientBase,
  anthropic: Anthropic,
  model: string,
  schema: string,
  gateTasks: GateTask[],
  threshold: number,
  runs: number,
): Promise<BCompetenceResult> {
  const provider = createCatalogProvider(pgClient, schema, true); // arm B

  let total = 0;
  let correct = 0;
  const perTask: BCompetenceResult['perTask'] = [];

  for (const task of gateTasks) {
    let taskCorrect = 0;
    for (let r = 0; r < runs; r += 1) {
      const res = await runAgentLoop({ client: anthropic, model, task, provider });
      let ok = false;
      if (res.ok) {
        const exec = await executeTaskSql(pgClient, res.sql);
        ok = exec.ok && scoreRows(task.scoring, exec.rows).correct;
      }
      total += 1;
      if (ok) {
        correct += 1;
        taskCorrect += 1;
      }
    }
    perTask.push({ id: task.id, correct: taskCorrect, runs });
  }

  await provider.close();
  const accuracy = total === 0 ? 0 : correct / total;
  return { pass: accuracy >= threshold, threshold, accuracy, runs, perTask };
}
