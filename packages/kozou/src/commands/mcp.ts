// `kozou mcp` command implementation.
//
// --stdio: spins up the @kozou/mcp server with a stdio transport, reading
//   connection details from kozou.config.yaml / environment.
// --http: deferred to v0.1.1 per dev_spec §16.1.1 B. Prints a hand-off note
//   to stderr and exits cleanly.
//
// See dev_spec §9.1 and §7.

import { SchemaCache, startStdioServer } from '@kozou/mcp';
import { loadConfig } from '../config.js';

export type McpOptions = {
  stdio?: boolean;
  http?: boolean;
  port?: number;
  config?: string;
};

const HTTP_HANDOFF_MESSAGE =
  'kozou mcp --http: HTTP transport is scheduled for v0.1.1.\n' +
  '  See Kozou v0.1 design spec §16.1.1 B for the roadmap.\n' +
  '  Use --stdio for now (the default).\n';

export async function mcpCommand(opts: McpOptions = {}): Promise<void> {
  // --http is deferred to v0.1.1 (HTTP transport not yet implemented in
  // the underlying @kozou/mcp package).
  if (opts.http === true) {
    process.stderr.write(HTTP_HANDOFF_MESSAGE);
    return;
  }

  const config = await loadConfig({ path: opts.config });

  const cache = new SchemaCache({
    connection: config.database.url,
    schemas: config.database.schemas,
    ttlMs: config.cache.ttlMs,
  });

  await startStdioServer(cache, { logPrefix: '[kozou mcp]' });
}
