// In-process SchemaContext cache.
// Wraps a loader behind a TTL and a single in-flight promise so that
// concurrent SvelteKit requests cannot trigger duplicate introspect
// calls against PostgreSQL. The hooks.server.ts module composes this
// with the @kozou/introspect + @kozou/core pipeline; tests inject a
// stub loader + clock to keep the module pure.

import type { SchemaContext } from '@kozou/core';

export type SchemaLoader = () => Promise<SchemaContext>;
export type Clock = () => number;

export interface SchemaCacheOptions {
  loader: SchemaLoader;
  /** Cache TTL in milliseconds. Defaults to 60_000 (Kozou v0.1 spec §8.5). */
  ttlMs?: number;
  /** Time source. Defaults to Date.now. */
  clock?: Clock;
}

const DEFAULT_TTL_MS = 60_000;

export class SchemaCache {
  private value: SchemaContext | null = null;
  private lastBuiltAt = 0;
  private inflight: Promise<SchemaContext> | null = null;
  private readonly loader: SchemaLoader;
  private readonly ttlMs: number;
  private readonly clock: Clock;

  constructor(opts: SchemaCacheOptions) {
    this.loader = opts.loader;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.clock = opts.clock ?? Date.now;
  }

  async get(): Promise<SchemaContext> {
    const now = this.clock();
    if (this.value !== null && now - this.lastBuiltAt <= this.ttlMs) {
      return this.value;
    }
    if (this.inflight !== null) {
      return this.inflight;
    }
    this.inflight = (async () => {
      try {
        const next = await this.loader();
        this.value = next;
        this.lastBuiltAt = this.clock();
        return next;
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  invalidate(): void {
    this.value = null;
    this.lastBuiltAt = 0;
  }
}
