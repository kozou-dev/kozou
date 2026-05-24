// Convenience helper to start an MCP server with the stdio transport.
//
// This lives in @kozou/mcp so callers (the bundled kozou CLI as well as
// adopters embedding the MCP server in their own scripts) do not need to
// depend on @modelcontextprotocol/sdk directly.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './server.js';
import type { SchemaCache } from './schemaCache.js';

export type StartStdioServerOptions = {
  /** Prefix used in stderr log lines. Default: '[@kozou/mcp]'. */
  logPrefix?: string;
};

/**
 * Start the MCP server bound to the given SchemaCache, using a stdio
 * transport. Installs a SIGHUP handler that invalidates the cache, so
 * adopters can refresh the schema without restarting the process.
 *
 * Resolves once the underlying transport finishes connecting.
 */
export async function startStdioServer(
  cache: SchemaCache,
  opts: StartStdioServerOptions = {},
): Promise<void> {
  const prefix = opts.logPrefix ?? '[@kozou/mcp]';
  const server = createMcpServer(cache);
  process.on('SIGHUP', () => {
    cache.invalidate();
    process.stderr.write(`${prefix} SIGHUP received, cache invalidated\n`);
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
