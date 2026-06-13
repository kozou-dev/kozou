// SvelteKit server hooks. Builds a SchemaContext once per TTL and
// hangs it off event.locals so every route module can access it
// synchronously via PageServerLoad / Actions. The TTL + in-flight
// dedupe live in $lib/server/schema-cache; this file is a thin
// adapter that wires DATABASE_URL into the introspect + buildSchema
// Context pipeline.
//
// `fkRowCache` is a sibling singleton kept alive for the same
// process lifetime; the detail route resolves each FK column on the
// page through it so navigating between sibling detail pages reuses
// the same referenced rows.

import type { Handle } from '@sveltejs/kit';

import { buildSchemaContext } from '@kozou/core';
import { introspect } from '@kozou/introspect';

import { FkRowCache } from '$lib/server/fk-row-cache.js';
import { SchemaCache } from '$lib/server/schema-cache.js';

const cache = new SchemaCache({
  loader: async () => {
    const connection = process.env.DATABASE_URL;
    if (typeof connection !== 'string' || connection.length === 0) {
      throw new Error(
        'hooks.server: DATABASE_URL is required to introspect the schema.',
      );
    }
    // Privilege-aware introspection (issue #99): when `kozou dev` resolves a
    // role for the Admin UI (introspection.respectPrivileges on), it passes it
    // through as KOZOU_INTROSPECTION_ROLE. Present + non-empty => evaluate that
    // role's table/column privileges so unreadable tables are hidden and
    // non-updatable columns render read-only. Absent => schema-faithful (the
    // default; the @kozou/api server and MCP stay schema-wide regardless).
    const privilegeRole = process.env.KOZOU_INTROSPECTION_ROLE;
    const raw = await introspect({
      connection,
      ...(typeof privilegeRole === 'string' && privilegeRole.length > 0
        ? { privilegeRole }
        : {}),
    });
    // RPC exposure config (issue #103): `kozou dev` forwards the operator's
    // api.rpc allowlists (comma-separated, schema-qualified) so the Admin UI
    // "Actions" surface exposes the same functions the API serves — including
    // the SECURITY DEFINER / public ones the operator opted in. Absent => only
    // invoker functions with PUBLIC EXECUTE revoked are exposed.
    return buildSchemaContext({
      raw,
      rpc: {
        allowDefiner: parseList(process.env.KOZOU_RPC_ALLOW_DEFINER),
        allowPublicExecute: parseList(process.env.KOZOU_RPC_ALLOW_PUBLIC_EXECUTE),
      },
    });
  },
});

/** Parse a comma-separated env list into trimmed, non-empty entries. */
function parseList(raw: string | undefined): string[] {
  if (raw === undefined || raw.length === 0) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const fkRowCache = new FkRowCache();

export const handle: Handle = async ({ event, resolve }) => {
  event.locals.schema = await cache.get();
  event.locals.fkRowCache = fkRowCache;
  return resolve(event);
};
