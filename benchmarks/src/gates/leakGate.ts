// Leak gate (anti-rigging): does the LEGACY NAMING leak business meaning?
//
// Run arm A (comment-less) NON-agentically — the full core DDL is presented at
// once, so there is zero navigation load — on the strong-trap tasks only. If A
// scores above the pre-registered threshold, the opaque names/structure are
// leaking meaning and the fixture must be re-mangled. Running non-agentically
// is essential (C-6): in an agentic setting, a low A score could come from an
// inability to navigate 200 tables rather than from names not leaking meaning.

import type Anthropic from '@anthropic-ai/sdk';
import type { ClientBase } from 'pg';

import { describeRelation } from '../tools/catalog.js';
import { generateSchema } from '../schema/generate.js';
import { askBFlat } from '../agent/bflat.js';
import { executeTaskSql, scoreRows } from '../score.js';
import type { BenchTask } from '../types.js';

/** A-style DDL (no comments) of the CORE relations only — zero noise, zero
 *  navigation. This is the surface a naive agent would read; if it suffices to
 *  answer strong-trap tasks, the names leak. */
export async function buildCoreDdlContext(client: ClientBase, schema: string): Promise<string> {
  const legend = generateSchema('S').legend;
  const tableNames = Object.entries(legend).filter(([k]) => k.startsWith('t:')).map(([, v]) => v);
  const viewNames = Object.entries(legend).filter(([k]) => k.startsWith('v:')).map(([, v]) => v);
  const blocks = ['-- Full schema (raw DDL only; no documentation).'];
  for (const name of tableNames) {
    blocks.push(await describeRelation(client, schema, name, { includeComments: false, includeViewDef: false }));
  }
  for (const name of viewNames) {
    blocks.push(await describeRelation(client, schema, name, { includeComments: false, includeViewDef: true }));
  }
  return blocks.join('\n\n');
}

export interface LeakGateResult {
  pass: boolean;
  threshold: number;
  accuracy: number;
  runs: number;
  strongTrapCount: number;
  contextChars: number;
  perTask: Array<{ id: string; correct: number; runs: number }>;
}

/**
 * @param threshold max acceptable strong-trap accuracy for arm A (e.g. 0.40).
 * @param runs single-shot repetitions per task.
 */
export async function runLeakGate(
  pgClient: ClientBase,
  anthropic: Anthropic,
  model: string,
  schema: string,
  tasks: BenchTask[],
  threshold: number,
  runs: number,
): Promise<LeakGateResult> {
  const strong = tasks.filter((t) => t.strong_trap);
  const context = await buildCoreDdlContext(pgClient, schema);

  let total = 0;
  let correct = 0;
  const perTask: LeakGateResult['perTask'] = [];

  for (const task of strong) {
    let taskCorrect = 0;
    for (let r = 0; r < runs; r += 1) {
      const ans = await askBFlat(anthropic, model, task, context);
      let ok = false;
      if (ans.ok) {
        const exec = await executeTaskSql(pgClient, ans.sql);
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

  const accuracy = total === 0 ? 0 : correct / total;
  return {
    pass: accuracy <= threshold,
    threshold,
    accuracy,
    runs,
    strongTrapCount: strong.length,
    contextChars: context.length,
    perTask,
  };
}
