// `kozou docs` command implementation.
//
// Pipeline (mirrors `kozou inspect`):
//   1. Load the kozou.config.yaml (or fall back to defaults).
//   2. Introspect the target Postgres schema (@kozou/introspect).
//   3. Optionally load UI hints (@kozou/core.loadUIHints).
//   4. Build a SchemaContext (@kozou/core.buildSchemaContext).
//   5. Render a Markdown schema document and write it out.
//
// See product_architecture_v3 §3.4 (the "docs" emit target).

import { writeFile } from 'node:fs/promises';
import { buildSchemaContext, loadUIHints } from '@kozou/core';
import type { UIHints } from '@kozou/core';
import { introspect } from '@kozou/introspect';
import { loadConfig } from '../config.js';
import { emitMarkdown } from '../docs.js';

const PREFIX = '[kozou docs]';

export type DocsOptions = {
  /** Output destination. '-' = stdout (default), otherwise a file path. */
  output?: string;
  /** Path to kozou.config.yaml. Default: ./kozou.config.yaml. */
  config?: string;
};

export async function docsCommand(opts: DocsOptions = {}): Promise<void> {
  const output = opts.output ?? '-';

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
      process.stderr.write(`${PREFIX} could not load UI hints: ${message}\n`);
    }
  }

  const ctx = await buildSchemaContext({ raw, uiHints });
  const serialized = emitMarkdown(ctx);
  const payload = serialized.endsWith('\n') ? serialized : serialized + '\n';

  if (output === '-') {
    process.stdout.write(payload);
    return;
  }
  await writeFile(output, payload, 'utf8');
}
