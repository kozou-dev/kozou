// `kozou mcp` command implementation.
//
// --stdio: spins up the @kozou/mcp server with a stdio transport, reading
//   connection details from kozou.config.yaml / environment.
// --http: spins up the @kozou/mcp server with the Streamable HTTP
//   transport, binding to localhost by default and
//   exposing POST /admin/refresh for cache invalidation. Rejected when
//   server.mcp.http.enabled is false (that config turns the endpoint off).
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
  resolveMcpAuthOptions,
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
 *  execution is disabled (describe-only, the default). Without the OAuth
 *  resource-server block the fixed `role` is required (the config schema
 *  guarantees it; kept explicit rather than asserted away). With the block,
 *  calls run as each verified token's role — a configured `role` is ignored
 *  (the server prints a notice). */
async function buildExecution(config: KozouConfig, authOn: boolean): Promise<McpExecution | undefined> {
  const exec = config.server.mcp.execution;
  if (!exec.enabled) return undefined;
  if (exec.role === undefined && !authOn) {
    // No OAuth per-token identity here (stdio mode, or --http without an auth
    // block), so a fixed role is the only identity execution can run as.
    throw new Error(
      'server.mcp.execution.role is required when execution is enabled without OAuth ' +
        'per-token identity (stdio mode, or --http without server.mcp.http.auth). ' +
        'Add server.mcp.execution.role, or run --http with an auth block.',
    );
  }
  const { default: pg } = await import('pg');
  // Write-capable pool, distinct from the SchemaCache's read-only introspection
  // client. The login role must be able to SET ROLE to the target role.
  const pool = new pg.Pool({ connectionString: config.database.url });
  return {
    pool,
    ...(exec.role === undefined ? {} : { role: exec.role }),
    claimsGuc: config.auth?.claimsGuc ?? DEFAULT_CLAIMS_GUC,
    claims: exec.claims ?? {},
    ...(exec.allow === undefined ? {} : { allow: exec.allow }),
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
 *
 *  With the OAuth resource-server block the acting role is per-token, so a
 *  single annotated role is only truthful when exactly one role is assumable
 *  (allowedRoles names one role). Any other combination is refused — a
 *  per-caller annotation is the planned respectPrivileges deepening, not
 *  something to fake with a config-picked role. Pure + exported for testing. */
export function resolveMcpAnnotationRole(
  config: KozouConfig,
  executionRole: string | undefined,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (!config.introspection.respectPrivileges) return undefined;
  const mcpAuth = config.server.mcp.http.auth;
  if (mcpAuth !== undefined) {
    const allowed = mcpAuth.allowedRoles ?? config.auth?.allowedRoles;
    const single = allowed !== undefined && allowed.length === 1 ? allowed[0] : undefined;
    if (single === undefined) {
      throw new Error(
        'introspection.respectPrivileges with server.mcp.http.auth needs allowedRoles to name ' +
          'exactly one role: the acting role is per-token, so a single annotated role is only ' +
          'truthful when only one role is assumable. Narrow allowedRoles or turn ' +
          'respectPrivileges off for the MCP server.',
      );
    }
    const explicit = config.introspection.role;
    if (explicit !== undefined && explicit !== single) {
      throw new Error(
        `introspection.role ("${explicit}") differs from the single allowed token role ` +
          `("${single}"): the describe tools would tell the agent role "${explicit}"'s ` +
          `privileges while it acts as "${single}". Set them to the same role.`,
      );
    }
    return single;
  }
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

  // OAuth applies to the HTTP transport only, so the per-token identity (which
  // lets execution.role be omitted) exists only in --http mode. In stdio mode
  // the auth block is ignored, so execution still needs its fixed role — base
  // the relaxation on the *selected* transport, not merely on the block's
  // presence, or a stdio run of an HTTP-auth config would reach startStdioServer
  // with no identity and fail late.
  const httpMode = opts.http === true;
  // `--http` against a config that turned the endpoint off is a contradiction,
  // and serving it anyway would be a silent posture change of exactly the kind
  // the flag exists to prevent. Fail before any listener or pool is opened, and
  // name both sides so the operator can pick which one they meant. stdio is
  // unaffected: server.mcp.http governs the HTTP endpoint only.
  if (httpMode && !config.server.mcp.http.enabled) {
    throw new Error(
      '--http was requested but the MCP HTTP endpoint is disabled ' +
        '(server.mcp.http.enabled in the config, or KOZOU_MCP_HTTP_ENABLED in the ' +
        'environment — name both because either can be the source). Set it to true ' +
        'to serve the endpoint, or drop --http (stdio is unaffected).',
    );
  }
  const mcpAuth = resolveMcpAuthOptions(config);
  const execution = await buildExecution(config, mcpAuth !== undefined && httpMode);
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
    const who = mcpAuth !== undefined ? `each verified token's role` : `role "${execution.role}"`;
    process.stderr.write(
      `[kozou mcp] \`call\` execution ENABLED: runs as ${who} (${scope} functions)\n`,
    );
  }

  if (opts.http === true) {
    await startHttpServer(cache, {
      // Precedence: a CLI flag overrides the config, which overrides the
      // library default — matching `kozou dev`. (`??` so an explicit `--port 0`
      // for an ephemeral port is honoured rather than falling back to config.)
      port: opts.port ?? config.server.mcp.http.port,
      host: opts.host ?? config.server.mcp.http.host,
      logPrefix: '[kozou mcp]',
      execution,
      provenance: config.server.mcp.provenance,
      ...(mcpAuth === undefined ? {} : { auth: mcpAuth }),
    });
    return;
  }

  if (mcpAuth !== undefined) {
    // OAuth applies to the HTTP transport only; stdio is same-machine trust
    // (the client process was launched by the operator). Say so instead of
    // silently ignoring the block. Execution then needs its fixed role.
    process.stderr.write(
      '[kozou mcp] NOTE: server.mcp.http.auth applies to --http only; stdio runs unauthenticated ' +
        'under local process trust.\n',
    );
  }
  await startStdioServer(cache, {
    logPrefix: '[kozou mcp]',
    execution,
    provenance: config.server.mcp.provenance,
  });
}
