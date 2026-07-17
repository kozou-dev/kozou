import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse as parseYaml } from 'yaml';

import { generateSchema } from './schema/generate.js';
import {
  taskSetSchema,
  gateTaskSetSchema,
  type BenchTask,
  type GateTask,
} from './types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const TASKSET_PATH = path.resolve(here, '../tasks/taskset.yaml');
export const GATE_TASKSET_PATH = path.resolve(here, '../tasks/gate-taskset.yaml');

/** Core legend is identical at every scale, so resolve against any scale. */
function coreLegend(): Record<string, string> {
  return generateSchema('S').legend;
}

/** Replace {{t:..}} / {{c:table.col}} / {{v:..}} with the mangled names. */
export function resolvePlaceholders(sql: string, legend = coreLegend()): string {
  return sql.replace(/\{\{([^}]+)\}\}/g, (_m, key: string) => {
    const name = legend[key.trim()];
    if (name === undefined) {
      throw new Error(`unknown schema placeholder {{${key}}} in canonical_sql`);
    }
    return name;
  });
}

function ensureUniqueIds(ids: string[]): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw new Error(`duplicate task id: ${id}`);
    seen.add(id);
  }
}

/** Load, validate, and resolve the main task set (canonical_sql resolved). */
export function loadTasks(): BenchTask[] {
  const raw: unknown = parseYaml(readFileSync(TASKSET_PATH, 'utf8'));
  const parsed = taskSetSchema.parse(raw);
  ensureUniqueIds(parsed.tasks.map((t) => t.id));
  const legend = coreLegend();
  return parsed.tasks.map((t) => ({ ...t, canonical_sql: resolvePlaceholders(t.canonical_sql, legend) }));
}

/** Load the B-competence gate task set (canonical_sql resolved). */
export function loadGateTasks(): GateTask[] {
  const raw: unknown = parseYaml(readFileSync(GATE_TASKSET_PATH, 'utf8'));
  const parsed = gateTaskSetSchema.parse(raw);
  ensureUniqueIds(parsed.tasks.map((t) => t.id));
  const legend = coreLegend();
  return parsed.tasks.map((t) => ({ ...t, canonical_sql: resolvePlaceholders(t.canonical_sql, legend) }));
}

/** The raw (unresolved) task set, for tooling that needs placeholders. */
export function loadRawTasks(): BenchTask[] {
  const raw: unknown = parseYaml(readFileSync(TASKSET_PATH, 'utf8'));
  return taskSetSchema.parse(raw).tasks;
}
