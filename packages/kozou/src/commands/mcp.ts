// `kozou mcp` command implementation.
//
// --stdio: spins up the @kozou/mcp server with a stdio transport, reading
//   connection details from kozou.config.yaml / environment.
// --http: spins up the @kozou/mcp server with the Streamable HTTP
//   transport (Kozou v0.1 spec §7.1), binding to localhost by default and
//   exposing POST /admin/refresh for cache invalidation (§7.5).
//
// See Kozou v0.1 design spec §9.1 and §7.

import { SchemaCache, startHttpServer, startStdioServer } from '@kozou/mcp';
import { loadConfig } from '../config.js';

export type McpOptions = {
  stdio?: boolean;
  http?: boolean;
  port?: number;
  host?: string;
  config?: string;
};

export async function mcpCommand(opts: McpOptions = {}): Promise<void> {
  const config = await loadConfig({ path: opts.config });

  const cache = new SchemaCache({
    connection: config.database.url,
    schemas: config.database.schemas,
    ttlMs: config.cache.ttlMs,
  });

  if (opts.http === true) {
    await startHttpServer(cache, {
      port: opts.port,
      host: opts.host,
      logPrefix: '[kozou mcp]',
    });
    return;
  }

  await startStdioServer(cache, { logPrefix: '[kozou mcp]' });
}
