// `kozou mcp` command implementation.
//
// --stdio: spins up the @kozou/mcp server with a stdio transport, reading
//   connection details from kozou.config.yaml / environment.
// --http: spins up the @kozou/mcp server with the Streamable HTTP
//   transport, binding to localhost by default and
//   exposing POST /admin/refresh for cache invalidation.
//
// The `call` execution tool is opt-in (server.mcp.execution.enabled, default
// OFF). When on, this command opens a write-capable pool and runs calls under
// the operator's single execution role via the shared role-transaction
// envelope. This is the home for execution; the env-only standalone @kozou/mcp
// CLI stays describe-only.

import { SchemaCache, startHttpServer, startStdioServer, type McpExecution } from '@kozou/mcp';
import { loadConfig, type KozouConfig } from '../config.js';

export type McpOptions = {
  stdio?: boolean;
  http?: boolean;
  port?: number;
  host?: string;
  config?: string;
};

// Default GUC the claims are published under — must match @kozou/api's default
// (auth.claimsGuc) so a single set of row-level-security policies applies to
// both the REST surface and the MCP `call` tool.
const DEFAULT_CLAIMS_GUC = 'request.jwt.claims';

/** Build the opt-in execution capability for the `call` tool, or undefined when
 *  execution is disabled (describe-only, the default). */
async function buildExecution(config: KozouConfig): Promise<McpExecution | undefined> {
  const exec = config.server.mcp.execution;
  if (!exec.enabled) return undefined;
  if (exec.role === undefined) {
    // The config schema's refine guarantees a role when enabled; keep the
    // contract explicit rather than asserting it away.
    throw new Error('server.mcp.execution.role is required when execution is enabled.');
  }
  const { default: pg } = await import('pg');
  // Write-capable pool, distinct from the SchemaCache's read-only introspection
  // client. The login role must be able to SET ROLE to the execution role.
  const pool = new pg.Pool({ connectionString: config.database.url });
  return {
    pool,
    role: exec.role,
    claimsGuc: config.auth?.claimsGuc ?? DEFAULT_CLAIMS_GUC,
    claims: exec.claims ?? {},
    allow: exec.allow,
  };
}

export async function mcpCommand(opts: McpOptions = {}): Promise<void> {
  const config = await loadConfig({ path: opts.config });

  const cache = new SchemaCache({
    connection: config.database.url,
    schemas: config.database.schemas,
    ttlMs: config.cache.ttlMs,
    // describe_functions advertises the operator's exposed RPC set (issue #103).
    rpc: config.api.rpc,
  });

  const execution = await buildExecution(config);
  if (execution !== undefined) {
    const scope = execution.allow ? `${execution.allow.length} allowlisted` : 'all exposed';
    process.stderr.write(
      `[kozou mcp] \`call\` execution ENABLED: runs as role "${execution.role}" (${scope} functions)\n`,
    );
  }

  if (opts.http === true) {
    await startHttpServer(cache, {
      port: opts.port,
      host: opts.host,
      logPrefix: '[kozou mcp]',
      execution,
    });
    return;
  }

  await startStdioServer(cache, { logPrefix: '[kozou mcp]', execution });
}
