// `kozou codegen` command implementation.
//
// Pipeline (mirrors `kozou inspect`):
//   1. Load the kozou.config.yaml (or fall back to defaults).
//   2. Introspect the target Postgres schema (@kozou/introspect).
//   3. Optionally load UI hints (@kozou/core.loadUIHints).
//   4. Build a SchemaContext (@kozou/core.buildSchemaContext).
//   5. Emit TypeScript row types (@kozou/codegen) and write them out.
//
// @kozou/codegen is an experimental, unpublished workspace package, so it is
// imported dynamically and is only resolvable from a source / workspace
// checkout — a published `kozou` install gets a clear error (mirrors the
// `--adapter api` handling in dev.ts).

import { writeFile } from 'node:fs/promises';
import { buildSchemaContext, loadUIHints } from '@kozou/core';
import type { UIHints } from '@kozou/core';
import { introspect } from '@kozou/introspect';
import { loadConfig } from '../config.js';

const PREFIX = '[kozou codegen]';

export type CodegenOptions = {
  /** Output destination. '-' = stdout (default), otherwise a file path. */
  output?: string;
  /** Path to kozou.config.yaml. Default: ./kozou.config.yaml. */
  config?: string;
};

export async function codegenCommand(opts: CodegenOptions = {}): Promise<void> {
  const output = opts.output ?? '-';

  let codegenModule: typeof import('@kozou/codegen');
  try {
    codegenModule = await import('@kozou/codegen');
  } catch {
    throw new Error(
      `${PREFIX} needs the experimental @kozou/codegen package, which is not ` +
        'bundled in this release. Run kozou from a source / workspace checkout to use it.',
    );
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
      process.stderr.write(`${PREFIX} could not load UI hints: ${message}\n`);
    }
  }

  const ctx = await buildSchemaContext({ raw, uiHints });
  const serialized = codegenModule.emitRowTypes(ctx);
  const payload = serialized.endsWith('\n') ? serialized : serialized + '\n';

  if (output === '-') {
    process.stdout.write(payload);
    return;
  }
  await writeFile(output, payload, 'utf8');
}
