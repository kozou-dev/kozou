import { describe, it, expect } from 'vitest';
import type { Client } from 'pg';

import { KozouIntrospectError, runQuery } from '../src/errors.js';

// Pure unit tests for the error type + runQuery wrapper. No database is
// needed: the failure paths are exercised with a fake client whose
// `query` resolves or rejects on demand.

describe('KozouIntrospectError', () => {
  it('defaults query/pgErrorCode/cause to undefined and sets the name', () => {
    const err = new KozouIntrospectError('boom');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('KozouIntrospectError');
    expect(err.message).toBe('boom');
    expect(err.query).toBeUndefined();
    expect(err.pgErrorCode).toBeUndefined();
    expect(err.cause).toBeUndefined();
  });

  it('carries query, pgErrorCode and cause when provided', () => {
    const cause = new Error('root');
    const err = new KozouIntrospectError('boom', {
      query: 'SELECT 1',
      pgErrorCode: '42501',
      cause,
    });
    expect(err.query).toBe('SELECT 1');
    expect(err.pgErrorCode).toBe('42501');
    expect(err.cause).toBe(cause);
  });
});

function fakeClient(query: () => Promise<unknown>): Client {
  return { query } as unknown as Client;
}

// Await `op`, asserting it rejects, and hand back the rejection typed as a
// KozouIntrospectError. Resolving instead is a test failure (so the union
// of `runQuery`'s success rows never leaks into the assertions below).
async function rejectionOf(op: Promise<unknown>): Promise<KozouIntrospectError> {
  return op.then(
    () => {
      throw new Error('expected runQuery to reject');
    },
    (e: unknown) => e as KozouIntrospectError,
  );
}

describe('runQuery', () => {
  it('returns the rows on success', async () => {
    const client = fakeClient(() => Promise.resolve({ rows: [{ a: 1 }, { a: 2 }] }));
    const rows = await runQuery<{ a: number }>(client, 'SELECT a', [], 'ctx');
    expect(rows).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('wraps a pg-style error with its code, message and cause', async () => {
    const pgErr = { code: '42P01', message: 'relation "x" does not exist' };
    const client = fakeClient(() => Promise.reject(pgErr));
    const error = await rejectionOf(
      runQuery(client, 'SELECT * FROM x', [], 'fetchThing'),
    );
    expect(error).toBeInstanceOf(KozouIntrospectError);
    expect(error.message).toBe('fetchThing: relation "x" does not exist');
    expect(error.pgErrorCode).toBe('42P01');
    expect(error.query).toBe('SELECT * FROM x');
    expect(error.cause).toBe(pgErr);
  });

  it('falls back to String(err) for a non-object throw and leaves pgErrorCode unset', async () => {
    const client = fakeClient(() => Promise.reject('plain string failure'));
    const error = await rejectionOf(runQuery(client, 'q', [], 'ctx'));
    expect(error).toBeInstanceOf(KozouIntrospectError);
    expect(error.message).toBe('ctx: plain string failure');
    expect(error.pgErrorCode).toBeUndefined();
  });

  it('uses String(err) when an object error carries no message', async () => {
    // isPgErrorLike(err) is true (object), but `.message` is absent, so the
    // `pgErr.message ?? String(err)` fallback applies.
    const client = fakeClient(() => Promise.reject({ code: '08006' }));
    const error = await rejectionOf(runQuery(client, 'q', [], 'ctx'));
    expect(error.pgErrorCode).toBe('08006');
    expect(error.message).toBe(`ctx: ${String({ code: '08006' })}`);
  });
});
