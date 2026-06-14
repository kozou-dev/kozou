import type { ConnectionPool } from '@kozou/core';

/**
 * The operator-configured capability that lets the MCP `call` tool execute
 * exposed functions. Absent = describe-only (the default): the `call` tool is
 * not listed and cannot run.
 *
 * Execution uses a single service role — there is no per-caller identity. The
 * MCP server has no end-user JWT, so a call runs as one fixed, operator-chosen
 * role; this is intentionally coarser than the REST surface and is unsuitable
 * for multi-tenant per-user authorization (use the REST API + per-user JWT for
 * that). The agent cannot choose the role or claims — that would let it
 * self-elevate.
 */
export type McpExecution = {
  /** Write-capable pool, separate from the read-only introspection client. A
   *  `pg.Pool` fits. */
  pool: ConnectionPool;
  /** Role assumed for every call via SET LOCAL ROLE. A dedicated least-privilege
   *  role is strongly recommended (not the owner / a superuser). */
  role: string;
  /** Runtime parameter the claims JSON is published under for row-level
   *  security, e.g. `request.jwt.claims`. */
  claimsGuc: string;
  /** Fixed claims published for RLS. `{}` when there are none. */
  claims: unknown;
  /** Optional allowlist of schema-qualified function names (`schema.fn`).
   *  undefined = every exposed function may be called. */
  allow?: string[];
};
