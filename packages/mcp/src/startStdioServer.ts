// Convenience helper to start an MCP server with the stdio transport.
//
// This lives in @kozou/mcp so callers (the bundled kozou CLI as well as
// adopters embedding the MCP server in their own scripts) do not need to
// depend on @modelcontextprotocol/sdk directly.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './server.js';
import type { SchemaCache } from './schemaCache.js';
import { fixedIdentity, type McpExecution } from './execution.js';

export type StartStdioServerOptions = {
  /** Prefix used in stderr log lines. Default: '[@kozou/mcp]'. */
  logPrefix?: string;
  /** Opt-in execution capability for the `call` tool. Omit = describe-only.
   *  stdio has no network exposure, so enabling it here is safe. stdio has
   *  no OAuth layer, so `execution.role` is required (calls run as it). */
  execution?: McpExecution;
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
  // Fail fast: stdio always runs calls under the fixed execution role.
  if (opts.execution !== undefined) fixedIdentity(opts.execution, prefix);
  const server = createMcpServer(cache, opts.execution);
  process.on('SIGHUP', () => {
    cache.invalidate();
    process.stderr.write(`${prefix} SIGHUP received, cache invalidated\n`);
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
