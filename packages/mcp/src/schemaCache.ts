import type { ClientConfig } from 'pg';
import { introspect } from '@kozou/introspect';
import { buildSchemaContext, type SchemaContext, type RpcBuildConfig } from '@kozou/core';

export type SchemaCacheOptions = {
  connection: string | ClientConfig;
  schemas?: string[];
  /** TTL in ms (default 60_000, per Kozou v0.1 spec §7.5) */
  ttlMs?: number;
  /** RPC exposure config (issue #103). Threaded into buildSchemaContext so
   *  `describe_functions` advertises the same exposed set as the REST `/rpc/`
   *  surface — including the SECURITY DEFINER / public functions the operator
   *  opted in. Omitted on the env-only standalone CLI (only invoker functions
   *  with PUBLIC EXECUTE revoked are then exposed). MCP stays privilege-wide:
   *  it never sets `privilegeRole`, so EXECUTE-based hiding does not apply. */
  rpc?: RpcBuildConfig;
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
    return buildSchemaContext({ raw, rpc: this.opts.rpc });
  }
}
