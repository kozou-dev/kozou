// `kozou inspect` command implementation.
//
// Pipeline:
//   1. Load the kozou.config.yaml (or fall back to defaults).
//   2. Introspect the target Postgres schema (@kozou/introspect).
//   3. Optionally load UI hints (@kozou/core.loadUIHints).
//   4. Build a SchemaContext (@kozou/core.buildSchemaContext).
//   5. Serialize to JSON or YAML and write to stdout or a file.
//
// See Kozou v0.1 design spec §9.1.

import { writeFile } from 'node:fs/promises';
import { stringify as stringifyYAML } from 'yaml';
import { buildSchemaContext, loadUIHints } from '@kozou/core';
import type { UIHints } from '@kozou/core';
import { introspect } from '@kozou/introspect';
import { loadConfig } from '../config.js';

export type InspectOptions = {
  /** Output format. Default: 'json'. */
  format?: 'json' | 'yaml';
  /** Output destination. '-' = stdout (default), otherwise a file path. */
  output?: string;
  /** Path to kozou.config.yaml. Default: ./kozou.config.yaml. */
  config?: string;
};

export async function inspectCommand(opts: InspectOptions = {}): Promise<void> {
  const format = opts.format ?? 'json';
  const output = opts.output ?? '-';
  if (format !== 'json' && format !== 'yaml') {
    throw new Error(`kozou inspect: invalid --format "${format}" (expected "json" or "yaml")`);
  }

  const config = await loadConfig({ path: opts.config });

  const raw = await introspect({
    connection: config.database.url,
    schemas: config.database.schemas,
  });

  let uiHints: UIHints | undefined;
  if (config.uiHints.path !== null && config.uiHints.path !== '') {
    try {
      uiHints = await loadUIHints(config.uiHints.path);
    } catch (err) {
      // UI hints are optional; warn but continue without them.
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[kozou inspect] could not load UI hints: ${message}\n`);
    }
  }

  const ctx = await buildSchemaContext({ raw, uiHints });
  const serialized = format === 'yaml' ? stringifyYAML(ctx) : JSON.stringify(ctx, null, 2);
  const payload = serialized.endsWith('\n') ? serialized : serialized + '\n';

  if (output === '-') {
    process.stdout.write(payload);
    return;
  }
  await writeFile(output, payload, 'utf8');
}
