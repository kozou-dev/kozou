// Server-side TTL cache for foreign key target rows.
//
// The detail route resolves each FK column on the page to the
// referenced row's displayField label. A naive lookup would hit the
// DataAdapter once per FK column per render; this cache keeps the
// resolved rows around for `ttlMs` so navigating between sibling
// detail pages (or re-rendering the same row) does not re-fetch the
// same target. Tracks FK label resolution via hooks.server TTL cache.
//
// The cache stores null on misses too. A real fetch error (network
// blip, 5xx) is caught by the caller's loader and surfaced as null,
// so subsequent renders within the TTL window keep showing the raw
// value rather than re-issuing the failing request; the TTL is short
// enough (default 60s) that transient failures self-heal.

import type { ResourceId } from '@kozou/core';

import { encodeResourceId } from '../resource-id.js';

export interface FkRowCacheOptions {
  /** Cache lifetime per entry, in milliseconds. Defaults to 60_000
   *  to match the SchemaCache TTL so a single render cycle re-uses
   *  hot rows. */
  ttlMs?: number;
  /** Injectable clock for unit tests. */
  now?: () => number;
}

export type FkRowLoader = (
  qualifiedName: string,
  id: ResourceId,
) => Promise<Record<string, unknown> | null>;

interface CacheEntry {
  row: Record<string, unknown> | null;
  fetchedAt: number;
}

export class FkRowCache {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, CacheEntry>();

  constructor(opts: FkRowCacheOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 60_000;
    this.now = opts.now ?? Date.now;
  }

  /** Return a cached row when one is fresh; otherwise run `loader` and
   *  cache its result (including `null`). The loader is responsible
   *  for swallowing network / adapter errors and resolving to `null`
   *  so callers see a uniform value-or-null contract. */
  async get(
    qualifiedName: string,
    id: ResourceId,
    loader: FkRowLoader,
  ): Promise<Record<string, unknown> | null> {
    const key = makeKey(qualifiedName, id);
    const existing = this.entries.get(key);
    const now = this.now();
    if (existing !== undefined && now - existing.fetchedAt < this.ttlMs) {
      return existing.row;
    }
    const row = await loader(qualifiedName, id);
    this.entries.set(key, { row, fetchedAt: now });
    return row;
  }

  /** Drop every cached entry. Mainly used by tests; production code
   *  leans on TTL expiry. */
  clear(): void {
    this.entries.clear();
  }

  /** Visible for tests. */
  size(): number {
    return this.entries.size;
  }
}

// The canonical encoded id keeps a composite key (raw-comma joined) distinct
// from a scalar that happens to contain a comma (percent-encoded).
function makeKey(qualifiedName: string, id: ResourceId): string {
  return `${qualifiedName}:${encodeResourceId(id)}`;
}
