// Module-scope DataAdapter singleton.
//
// Routes never import a concrete adapter directly; they ask for the
// configured DataAdapter through this getter so the eslint adapter-
// boundary rule (Kozou v0.1 design spec §18.1.1) keeps the backend
// plumbing hidden inside `src/lib/{adapter,server}`.
//
// KOZOU_ADAPTER_KIND selects the backend (Kozou v0.2 Phase 4):
//   - unset / "postgrest" (default): the REST adapter against PostgREST
//   - "api":                         the in-house @kozou/api server
// KOZOU_ADAPTER_URL overrides the base URL for whichever is selected.
// KOZOU_ADAPTER_TOKEN (api backend only): when the @kozou/api server has
// JWT auth enabled, this Bearer token is attached to every request. Under
// `kozou dev --adapter api` the CLI sets it; it is empty otherwise and the
// adapter sends no Authorization header (the unauthenticated default).

import type { SchemaContext } from '@kozou/core';
import type { DataAdapter } from '@kozou/core';

import { KozouApiDataAdapter, PostgrestDataAdapter } from '$lib/adapter/index.js';

const DEFAULT_POSTGREST_URL = 'http://localhost:3000';
const DEFAULT_API_URL = 'http://localhost:3335';

let cached: DataAdapter | null = null;
let cachedSchema: SchemaContext | null = null;

/**
 * Resolve the configured DataAdapter.
 *
 * The in-house API adapter resolves primary keys server-side, so it ignores
 * `schema`. The REST adapter must address rows by their actual key columns
 * (a composite key expands to per-column filters), so it is wired with a
 * resolver derived from the live SchemaContext. The singleton is rebuilt when
 * the schema identity changes — the schema cache hands out a new object on its
 * TTL refresh — so the resolver tracks DDL changes.
 */
export function getAdapter(schema?: SchemaContext): DataAdapter {
  const nextSchema = schema ?? null;
  if (cached !== null && cachedSchema === nextSchema) {
    return cached;
  }
  cachedSchema = nextSchema;

  const kind = process.env.KOZOU_ADAPTER_KIND ?? 'postgrest';
  if (kind === 'api') {
    const baseUrl = process.env.KOZOU_ADAPTER_URL ?? DEFAULT_API_URL;
    const token = process.env.KOZOU_ADAPTER_TOKEN;
    const headers =
      token !== undefined && token.length > 0
        ? { Authorization: `Bearer ${token}` }
        : undefined;
    cached = new KozouApiDataAdapter({ baseUrl, headers });
  } else {
    const baseUrl = process.env.KOZOU_ADAPTER_URL ?? DEFAULT_POSTGREST_URL;
    cached = new PostgrestDataAdapter({
      baseUrl,
      primaryKey: primaryKeyResolver(schema),
    });
  }
  return cached;
}

// Mirrors the REST adapter's default schema: the factory above never sets
// `defaultSchema`, so a bare resource name resolves against this schema.
const DEFAULT_RESOLVER_SCHEMA = 'public';

/** Build a primary-key resolver from the schema: each resource maps to its
 *  ordered key columns. A bare (schema-less) resource name is matched
 *  against the default schema, the same normalization the adapter applies.
 *  A known key-less table keeps its empty key list so the adapter rejects
 *  by-id operations loudly instead of filtering on a possibly non-unique
 *  'id' column (wrong-row reads / mutations). The 'id' fallback applies
 *  only to unknown resources or when no schema is available. */
function primaryKeyResolver(
  schema: SchemaContext | undefined,
): ((resource: string) => string | string[]) | undefined {
  if (schema === undefined) return undefined;
  return (resource: string) => {
    const qualified = resource.includes('.')
      ? resource
      : `${DEFAULT_RESOLVER_SCHEMA}.${resource}`;
    const table = schema.tables.find((t) => t.qualifiedName === qualified);
    if (table !== undefined) {
      return table.primaryKey;
    }
    return 'id';
  };
}

/** Test-only hook to reset the singleton between runs. */
export function resetAdapterForTests(): void {
  cached = null;
  cachedSchema = null;
}
