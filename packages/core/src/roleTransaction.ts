// The single role-switching transaction envelope shared by every surface that
// runs queries under an enforced database identity.
//
// The REST layer carries a per-request JWT and assumes the role it names; the
// MCP execution surface assumes a single operator-configured role. Both need
// the exact same envelope — open a dedicated connection, BEGIN, SET LOCAL ROLE,
// publish the claims for row-level security, run the work, COMMIT (or ROLLBACK
// on any error), and always return the connection to the pool. Keeping that
// envelope in one place is what stops the two surfaces from drifting: the
// privilege model (PostgreSQL's own EXECUTE / RLS enforcement) is applied
// identically no matter which surface issued the call.

import { quoteIdent } from './ident.js';

/** Minimal query interface satisfied by both `pg.Pool` and `pg.Client`. */
export type Queryable = {
  query<R extends Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
};

/** A pooled client: a Queryable that can be returned to its pool. A
 *  node-postgres `PoolClient` satisfies this. */
export type PoolClient = Queryable & { release(err?: boolean | Error): void };

/** A connection pool able to hand out dedicated clients. A `pg.Pool` fits. */
export type ConnectionPool = { connect(): Promise<PoolClient> };

/** The database identity a transaction runs under. */
export type RoleTransaction = {
  /** Role assumed for the transaction via `SET LOCAL ROLE`. */
  role: string;
  /** Runtime parameter the claims JSON is published under (e.g.
   *  `request.jwt.claims`) so row-level-security policies can read them. */
  claimsGuc: string;
  /** Claims object published for RLS. Pass `{}` when there are none. */
  claims: unknown;
};

/**
 * Run `work` on a dedicated pooled client inside a transaction that has assumed
 * `tx.role` and published `tx.claims`, so PostgreSQL's privileges and the
 * targets' own row-level-security policies apply to every query the callback
 * issues. Commits on success, rolls back on any error, and always returns the
 * client to the pool.
 *
 * The role is quoted as an identifier (it has no bound-parameter form); the
 * claims are always a bound parameter, never interpolated into SQL.
 */
export async function runInRoleTransaction<T>(
  pool: ConnectionPool,
  tx: RoleTransaction,
  work: (db: Queryable) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      await client.query(`SET LOCAL ROLE ${quoteIdent(tx.role)}`);
    } catch {
      // Don't surface the database's role error: the role is constrained by
      // the caller's allowlist, so a failure here is not a client-facing detail.
      throw new Error('Could not assume the requested role.');
    }
    await client.query('SELECT set_config($1, $2, true)', [tx.claimsGuc, JSON.stringify(tx.claims)]);
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The connection may already be in a failed state; nothing to do.
    }
    throw err;
  } finally {
    client.release();
  }
}
