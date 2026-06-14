// Server-side schema provider — the React spike's analogue of the Svelte
// reference UI's `hooks.server.ts`. Same pipeline, no framework binding:
// introspect DATABASE_URL once per TTL, build a SchemaContext, and hand it
// out through @kozou/ui-core's SchemaCache. A sibling FkRowCache is kept
// alive for the process lifetime so the detail route can resolve FK labels
// without re-fetching the same target rows.

import { buildSchemaContext } from '@kozou/core';
import { introspect } from '@kozou/introspect';
import { FkRowCache, SchemaCache } from '@kozou/ui-core';

const schemaCache = new SchemaCache({
  loader: async () => {
    const connection = process.env.DATABASE_URL;
    if (typeof connection !== 'string' || connection.length === 0) {
      throw new Error(
        'DATABASE_URL is required to introspect the schema for the read spike.',
      );
    }
    // Privilege-aware introspection (mirrors the Svelte reference's
    // hooks.server.ts): when KOZOU_INTROSPECTION_ROLE is set, evaluate that
    // role's table/column privileges so unreadable tables are hidden and
    // non-updatable columns are flagged. Absent => schema-faithful. RPC
    // exposure config is omitted on purpose: this read spike has no Actions
    // surface.
    const privilegeRole = process.env.KOZOU_INTROSPECTION_ROLE;
    const raw = await introspect({
      connection,
      ...(typeof privilegeRole === 'string' && privilegeRole.length > 0
        ? { privilegeRole }
        : {}),
    });
    return buildSchemaContext({ raw });
  },
});

/** Resolve the cached SchemaContext (refreshes on the cache's TTL). */
export function getSchema() {
  return schemaCache.get();
}

const fkRowCache = new FkRowCache();

/** The process-lifetime FK target-row cache shared across detail renders. */
export function getFkRowCache(): FkRowCache {
  return fkRowCache;
}
