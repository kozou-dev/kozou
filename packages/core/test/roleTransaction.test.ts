import { describe, it, expect } from 'vitest';
import {
  runInRoleTransaction,
  type ConnectionPool,
  type PoolClient,
  type RoleTransaction,
} from '../src/roleTransaction.js';

// A recording fake client/pool: no real database. We assert the exact envelope
// (BEGIN / SET LOCAL ROLE / set_config / COMMIT|ROLLBACK), that the role is
// quoted, the claims are bound (never interpolated), and the connection is
// always released.

type Recorded = { text: string; values?: unknown[] };

function makeClient(opts: { failOn?: (text: string) => boolean; failRollback?: boolean } = {}): {
  client: PoolClient;
  calls: Recorded[];
  releases: () => number;
} {
  const calls: Recorded[] = [];
  let releases = 0;
  const client: PoolClient = {
    query: ((text: string, values?: unknown[]) => {
      calls.push({ text, values });
      if (text === 'ROLLBACK' && opts.failRollback) {
        return Promise.reject(new Error('rollback failed'));
      }
      if (opts.failOn?.(text)) {
        return Promise.reject(new Error(`raw database detail for ${text}`));
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    }) as PoolClient['query'],
    release: () => {
      releases += 1;
    },
  };
  return { client, calls, releases: () => releases };
}

function poolOf(client: PoolClient): ConnectionPool {
  return { connect: () => Promise.resolve(client) };
}

const TX: RoleTransaction = {
  role: 'app_reader',
  claimsGuc: 'request.jwt.claims',
  claims: { sub: 'ada' },
};

describe('runInRoleTransaction', () => {
  it('runs the work inside the role + claims envelope and commits', async () => {
    const { client, calls, releases } = makeClient();
    const result = await runInRoleTransaction(poolOf(client), TX, async (db) => {
      await db.query('SELECT 1');
      return 42;
    });

    expect(result).toBe(42);
    expect(calls.map((c) => c.text)).toEqual([
      'BEGIN',
      'SET LOCAL ROLE "app_reader"',
      'SELECT set_config($1, $2, true)',
      'SELECT 1',
      'COMMIT',
    ]);
    // Claims are a bound parameter, never interpolated.
    expect(calls[2].values).toEqual(['request.jwt.claims', JSON.stringify({ sub: 'ada' })]);
    expect(releases()).toBe(1);
  });

  it('quotes the role identifier (defense in depth)', async () => {
    const { client, calls } = makeClient();
    await runInRoleTransaction(poolOf(client), { ...TX, role: 'weird"role' }, async () => undefined);
    expect(calls[1].text).toBe('SET LOCAL ROLE "weird""role"');
  });

  it('publishes empty claims as {}', async () => {
    const { client, calls } = makeClient();
    await runInRoleTransaction(poolOf(client), { ...TX, claims: {} }, async () => undefined);
    expect(calls[2].values).toEqual(['request.jwt.claims', '{}']);
  });

  it('rolls back and rethrows when the work throws, still releasing', async () => {
    const { client, calls, releases } = makeClient();
    const boom = new Error('boom');
    await expect(
      runInRoleTransaction(poolOf(client), TX, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);

    expect(calls.map((c) => c.text)).toEqual([
      'BEGIN',
      'SET LOCAL ROLE "app_reader"',
      'SELECT set_config($1, $2, true)',
      'ROLLBACK',
    ]);
    expect(releases()).toBe(1);
  });

  it('maps a role-assumption failure to a generic error without leaking the database detail', async () => {
    const { client, calls, releases } = makeClient({
      failOn: (t) => t.startsWith('SET LOCAL ROLE'),
    });
    await expect(runInRoleTransaction(poolOf(client), TX, async () => 1)).rejects.toThrow(
      'Could not assume the requested role.',
    );

    const thrown = await runInRoleTransaction(poolOf(makeClient({ failOn: (t) => t.startsWith('SET LOCAL ROLE') }).client), TX, async () => 1).catch(
      (e: unknown) => e,
    );
    expect(String((thrown as Error).message)).not.toContain('raw database detail');

    // The transaction is still rolled back and the connection released.
    expect(calls.map((c) => c.text)).toContain('ROLLBACK');
    expect(releases()).toBe(1);
  });

  it('rolls back on COMMIT failure and rethrows the commit error', async () => {
    const { client, calls, releases } = makeClient({ failOn: (t) => t === 'COMMIT' });
    await expect(runInRoleTransaction(poolOf(client), TX, async () => 1)).rejects.toThrow(
      /raw database detail for COMMIT/,
    );
    // A failed COMMIT must still be followed by a ROLLBACK — asserted on the
    // call log so the test is non-vacuous (it would fail if the catch's
    // rollback were skipped for the commit path).
    expect(calls.map((c) => c.text)).toEqual([
      'BEGIN',
      'SET LOCAL ROLE "app_reader"',
      'SELECT set_config($1, $2, true)',
      'COMMIT',
      'ROLLBACK',
    ]);
    expect(releases()).toBe(1);
  });

  it('swallows a ROLLBACK failure and still surfaces the original error', async () => {
    const { client, releases } = makeClient({ failRollback: true });
    const boom = new Error('original');
    await expect(
      runInRoleTransaction(poolOf(client), TX, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(releases()).toBe(1);
  });
});
