import type { ConnectionPool } from '@kozou/core';

/**
 * The operator-configured capability that lets the MCP `call` tool execute
 * exposed functions. Absent = describe-only (the default): the `call` tool is
 * not listed and cannot run.
 *
 * Identity depends on the transport's auth posture:
 *   - Without OAuth (the loopback default), execution uses a single fixed
 *     service role — `role` / `claims` here — and there is no per-caller
 *     identity. The agent cannot choose the role or claims — that would let
 *     it self-elevate.
 *   - With OAuth (`startHttpServer`'s `auth` option), every call runs as the
 *     *verified token's* role with the token's claims published for
 *     row-level security; `role` / `claims` here are ignored (a configured
 *     `role` draws a startup notice). The agent still cannot self-elevate:
 *     the role comes only from the verified claim, the operator's
 *     allowed-roles list, and PostgreSQL's own GRANT membership.
 */
export type McpExecution = {
  /** Write-capable pool, separate from the read-only introspection client. A
   *  `pg.Pool` fits. */
  pool: ConnectionPool;
  /** Fixed role assumed for every call via SET LOCAL ROLE when the server has
   *  no OAuth layer. REQUIRED in that mode (startup error when missing); a
   *  dedicated least-privilege role is strongly recommended (not the owner /
   *  a superuser). Ignored in OAuth mode, where the role is per-token. */
  role?: string;
  /** Runtime parameter the claims JSON is published under for row-level
   *  security, e.g. `request.jwt.claims`. */
  claimsGuc: string;
  /** Fixed claims published for RLS when the server has no OAuth layer.
   *  `{}` when there are none. Ignored in OAuth mode (per-token claims). */
  claims?: unknown;
  /** Optional allowlist of schema-qualified function names (`schema.fn`).
   *  undefined = every exposed function may be called. Applies in both
   *  modes — scope and role gate the caller, this gates the surface. */
  allow?: string[];
};

/** The identity a single `call` runs under: a fixed operator-configured one
 *  (no-auth mode) or the verified token's (OAuth mode). */
export type CallIdentity = { role: string; claims: unknown };

/** Resolve the fixed identity of a no-auth deployment, failing fast when the
 *  operator enabled execution without naming the role it runs as. */
export function fixedIdentity(execution: McpExecution, errorContext: string): CallIdentity {
  if (typeof execution.role !== 'string' || execution.role.length === 0) {
    throw new Error(
      `${errorContext}: execution.role is required when the server has no OAuth auth layer ` +
        '(without it there is no identity to run calls as).',
    );
  }
  return { role: execution.role, claims: execution.claims ?? {} };
}
