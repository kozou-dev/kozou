import type { Client } from 'pg';

export type KozouIntrospectErrorOptions = {
  /** The failed SQL body. Omitted on connection failure. */
  query?: string;
  /** PostgreSQL error code (e.g. "42501") */
  pgErrorCode?: string;
  /** The original error object (forwarded via the standard Error.cause field). */
  cause?: unknown;
};

export class KozouIntrospectError extends Error {
  readonly query?: string;
  readonly pgErrorCode?: string;
  constructor(message: string, options: KozouIntrospectErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'KozouIntrospectError';
    this.query = options.query;
    this.pgErrorCode = options.pgErrorCode;
  }
}

type PgErrorLike = { code?: string; message?: string };

function isPgErrorLike(value: unknown): value is PgErrorLike {
  return typeof value === 'object' && value !== null;
}

export async function runQuery<R extends Record<string, unknown>>(
  client: Client,
  query: string,
  params: unknown[],
  context: string,
): Promise<R[]> {
  try {
    const res = await client.query<R>(query, params);
    return res.rows;
  } catch (err) {
    const pgErr = isPgErrorLike(err) ? err : {};
    throw new KozouIntrospectError(`${context}: ${pgErr.message ?? String(err)}`, {
      query,
      pgErrorCode: pgErr.code,
      cause: err,
    });
  }
}
