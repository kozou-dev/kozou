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
  /** Open the transaction as `READ ONLY` so the database rejects any data
   *  change for the duration of the work. Set this for read-only operations
   *  (a GET / list / lookup): it makes the read-safe contract hold at the
   *  database level rather than relying on the role's grants, so a SELECT that
   *  reaches a volatile function or a writable/INSTEAD-triggered view cannot
   *  perform a write that then commits. Defaults to a read/write transaction,
   *  which a write operation (insert/update/delete, or a function call that may
   *  mutate) needs. */
  readOnly?: boolean;
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
  // When set, the connection could not be cleanly rolled back, so it is
  // released as broken (destroyed) rather than returned to the pool.
  let unclean: Error | undefined;
  try {
    // A read-only operation opens the transaction READ ONLY so PostgreSQL
    // rejects any write for its duration; SET LOCAL ROLE and publishing the
    // claims are catalog/session changes, not data writes, so they remain
    // allowed inside a READ ONLY transaction.
    await client.query(tx.readOnly === true ? 'BEGIN READ ONLY' : 'BEGIN');
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
      // Rollback failed: the connection's transaction state is unknown, so
      // flag it to be destroyed on release instead of reused from the pool.
      unclean = err instanceof Error ? err : new Error(String(err));
    }
    throw err;
  } finally {
    client.release(unclean);
  }
}
