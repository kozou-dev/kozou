import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse as parseYaml } from 'yaml';

import { taskSetSchema, type BenchTask } from './types.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export const TASKSET_PATH = path.resolve(here, '../tasks/taskset.yaml');

/** Load and validate the pre-registered task set. */
export function loadTasks(): BenchTask[] {
  const raw: unknown = parseYaml(readFileSync(TASKSET_PATH, 'utf8'));
  const parsed = taskSetSchema.parse(raw);
  const seen = new Set<string>();
  for (const task of parsed.tasks) {
    if (seen.has(task.id)) {
      throw new Error(`duplicate task id in taskset.yaml: ${task.id}`);
    }
    seen.add(task.id);
  }
  return parsed.tasks;
}
