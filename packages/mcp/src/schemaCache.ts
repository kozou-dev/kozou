import type { ClientConfig } from 'pg';
import { introspect } from '@kozou/introspect';
import { buildSchemaContext, type SchemaContext } from '@kozou/core';

export type SchemaCacheOptions = {
  connection: string | ClientConfig;
  schemas?: string[];
  /** TTL in ms (default 60_000、dev_spec §7.5) */
  ttlMs?: number;
};

export class SchemaCache {
  private cached: { ctx: SchemaContext; expiresAt: number } | null = null;
  private inflight: Promise<SchemaContext> | null = null;
  private readonly opts: SchemaCacheOptions;

  constructor(opts: SchemaCacheOptions) {
    this.opts = opts;
  }

  async get(): Promise<SchemaContext> {
    const now = Date.now();
    if (this.cached !== null && this.cached.expiresAt > now) {
      return this.cached.ctx;
    }
    if (this.inflight !== null) {
      return this.inflight;
    }
    const ttl = this.opts.ttlMs ?? 60_000;
    this.inflight = this.rebuild().finally(() => {
      this.inflight = null;
    });
    try {
      const ctx = await this.inflight;
      this.cached = { ctx, expiresAt: Date.now() + ttl };
      return ctx;
    } catch (err) {
      this.cached = null;
      throw err;
    }
  }

  invalidate(): void {
    this.cached = null;
  }

  private async rebuild(): Promise<SchemaContext> {
    const raw = await introspect({
      connection: this.opts.connection,
      schemas: this.opts.schemas,
    });
    return buildSchemaContext({ raw });
  }
}
