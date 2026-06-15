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
import {
  hasReadyMadeToken,
  loadConfig,
  resolvePrivilegeRole,
  type KozouConfig,
} from '../config.js';

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

/** Resolve the role the `kozou mcp` describe tools annotate (privilege-aware
 *  mode, issue #99), given whether the `call` execution tool is enabled and the
 *  role it runs as. The annotated role MUST be the role the agent actually acts
 *  as, or the annotation misleads: when execution is enabled the agent's writes
 *  run as the execution role, so annotate exactly that — and reject a
 *  conflicting explicit `introspection.role` (a silent "says A, does B" split is
 *  the hazard). Describe-only (no execution) resolves from config, refusing to
 *  guess a ready-made token's role. Returns undefined when the feature is off.
 *  Pure + exported for testing. */
export function resolveMcpAnnotationRole(
  config: KozouConfig,
  executionRole: string | undefined,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (!config.introspection.respectPrivileges) return undefined;
  if (executionRole !== undefined) {
    const explicit = config.introspection.role;
    if (explicit !== undefined && explicit !== executionRole) {
      throw new Error(
        `introspection.role ("${explicit}") differs from server.mcp.execution.role ` +
          `("${executionRole}"): the describe tools would tell the agent role "${explicit}"'s ` +
          `privileges while its \`call\` writes run as "${executionRole}". Set them to the same role.`,
      );
    }
    return executionRole;
  }
  return resolvePrivilegeRole(config, { suppliedToken: hasReadyMadeToken(config, env) });
}

export async function mcpCommand(opts: McpOptions = {}): Promise<void> {
  const config = await loadConfig({ path: opts.config });

  const execution = await buildExecution(config);
  const privilegeRole = resolveMcpAnnotationRole(config, execution?.role, process.env);

  const cache = new SchemaCache({
    connection: config.database.url,
    schemas: config.database.schemas,
    ttlMs: config.cache.ttlMs,
    // describe_functions advertises the operator's exposed RPC set (issue #103).
    rpc: config.api.rpc,
    ...(privilegeRole === undefined ? {} : { privilegeRole }),
  });

  if (privilegeRole !== undefined) {
    process.stderr.write(
      `[kozou mcp] privilege-aware context ON: describe tools annotate what role ` +
        `"${privilegeRole}" may touch (advisory; enforcement stays in PostgreSQL)\n`,
    );
  }

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
