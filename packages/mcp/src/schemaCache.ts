import type { ClientConfig } from 'pg';
import { introspect } from '@kozou/introspect';
import { buildSchemaContext, type SchemaContext, type RpcBuildConfig } from '@kozou/core';

export type SchemaCacheOptions = {
  connection: string | ClientConfig;
  schemas?: string[];
  /** TTL in ms (default 60_000) */
  ttlMs?: number;
  /** RPC exposure config (issue #103). Threaded into buildSchemaContext so
   *  `describe_functions` advertises the same exposed set as the REST `/rpc/`
   *  surface — including the SECURITY DEFINER / public functions the operator
   *  opted in. Omitted on the env-only standalone CLI (only invoker functions
   *  with PUBLIC EXECUTE revoked are then exposed). */
  rpc?: RpcBuildConfig;
  /** Privilege-aware introspection (issue #99). When set, the MCP server
   *  evaluates this role's effective table/column GRANTs and *annotates* the
   *  describe tools with them (`describe_table.privileges` + per-column
   *  `insertable` / `updatable`), so an agent is told what the role may touch.
   *  Unlike the Admin UI it does not hide unreadable relations — it keeps them
   *  and labels them (annotate mode). Omitted (the default) keeps the server
   *  schema-wide: no privileges are read or surfaced. Enforcement always stays
   *  in PostgreSQL; this is advisory context only. */
  privilegeRole?: string;
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
      privilegeRole: this.opts.privilegeRole,
    });
    // Annotate (don't hide) when a privilege role is set, so the agent sees
    // every relation and is told what it may touch. No role -> schema-wide.
    return buildSchemaContext({
      raw,
      rpc: this.opts.rpc,
      ...(this.opts.privilegeRole === undefined ? {} : { privilegeDisplay: 'annotate' as const }),
    });
  }
}
