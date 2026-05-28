import { describe, expect, it, vi } from 'vitest';

import { FkRowCache } from '../../src/lib/server/fk-row-cache.js';

describe('FkRowCache', () => {
  it('returns the loaded row and caches it within the TTL window', async () => {
    const loader = vi.fn(async () => ({ id: 'a', display_name: 'Author A' }));
    const cache = new FkRowCache({ ttlMs: 1_000, now: () => 0 });

    const first = await cache.get('public.authors', 'a', loader);
    const second = await cache.get('public.authors', 'a', loader);

    expect(first).toEqual({ id: 'a', display_name: 'Author A' });
    expect(second).toEqual({ id: 'a', display_name: 'Author A' });
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('refetches once the TTL window has elapsed', async () => {
    let clock = 0;
    const loader = vi.fn(async () => ({ id: 'a' }));
    const cache = new FkRowCache({ ttlMs: 100, now: () => clock });

    await cache.get('public.authors', 'a', loader);
    clock = 150;
    await cache.get('public.authors', 'a', loader);

    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('caches null results so a missing target does not retry within TTL', async () => {
    const loader = vi.fn(async () => null);
    const cache = new FkRowCache({ ttlMs: 1_000, now: () => 0 });

    expect(await cache.get('public.authors', 'missing', loader)).toBeNull();
    expect(await cache.get('public.authors', 'missing', loader)).toBeNull();
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('keys by (qualifiedName, id) so different tables do not collide', async () => {
    const loader = vi.fn(async (qn) => ({ table: qn }));
    const cache = new FkRowCache({ ttlMs: 1_000, now: () => 0 });

    await cache.get('public.authors', '1', loader);
    await cache.get('public.books', '1', loader);

    expect(loader).toHaveBeenCalledTimes(2);
    expect(cache.size()).toBe(2);
  });

  it('clear() drops every entry', async () => {
    const loader = vi.fn(async () => ({ id: 'a' }));
    const cache = new FkRowCache({ ttlMs: 1_000, now: () => 0 });

    await cache.get('public.authors', 'a', loader);
    expect(cache.size()).toBe(1);

    cache.clear();
    expect(cache.size()).toBe(0);

    await cache.get('public.authors', 'a', loader);
    expect(loader).toHaveBeenCalledTimes(2);
  });
});
