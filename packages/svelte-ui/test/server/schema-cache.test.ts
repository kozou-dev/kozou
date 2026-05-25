import { describe, expect, it, vi } from 'vitest';

import type { SchemaContext } from '@kozou/core';

import { SchemaCache } from '../../src/lib/server/schema-cache.js';

function makeContext(label: string): SchemaContext {
  return {
    tables: [],
    views: [],
    enums: [],
    concepts: [],
    metadata: { label },
  } as unknown as SchemaContext;
}

describe('SchemaCache', () => {
  it('loads the schema lazily on the first call and reuses it within TTL', async () => {
    const loader = vi.fn(async () => makeContext('first'));
    let now = 1_000;
    const cache = new SchemaCache({
      loader,
      ttlMs: 60_000,
      clock: () => now,
    });

    const first = await cache.get();
    now += 30_000;
    const second = await cache.get();

    expect(first).toBe(second);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('reloads the schema after the TTL elapses', async () => {
    let nth = 0;
    const loader = vi.fn(async () => {
      nth += 1;
      return makeContext(`load-${nth}`);
    });
    let now = 1_000;
    const cache = new SchemaCache({
      loader,
      ttlMs: 60_000,
      clock: () => now,
    });

    const first = await cache.get();
    now += 60_001;
    const second = await cache.get();

    expect(first).not.toBe(second);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('dedupes concurrent get() calls into a single in-flight load', async () => {
    let resolveLoader: ((ctx: SchemaContext) => void) | undefined;
    const loader = vi.fn(
      () =>
        new Promise<SchemaContext>((resolve) => {
          resolveLoader = resolve;
        }),
    );
    const cache = new SchemaCache({ loader });

    const promiseA = cache.get();
    const promiseB = cache.get();
    expect(loader).toHaveBeenCalledTimes(1);

    const ctx = makeContext('shared');
    resolveLoader?.(ctx);

    await expect(promiseA).resolves.toBe(ctx);
    await expect(promiseB).resolves.toBe(ctx);
  });

  it('reloads after invalidate()', async () => {
    let nth = 0;
    const loader = vi.fn(async () => {
      nth += 1;
      return makeContext(`load-${nth}`);
    });
    const cache = new SchemaCache({
      loader,
      ttlMs: 60_000,
      clock: () => 1_000,
    });

    const first = await cache.get();
    cache.invalidate();
    const second = await cache.get();

    expect(first).not.toBe(second);
    expect(loader).toHaveBeenCalledTimes(2);
  });
});
