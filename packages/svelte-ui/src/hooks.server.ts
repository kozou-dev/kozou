// SvelteKit server hooks. Builds a SchemaContext once per TTL and
// hangs it off event.locals so every route module can access it
// synchronously via PageServerLoad / Actions. The TTL + in-flight
// dedupe live in $lib/server/schema-cache; this file is a thin
// adapter that wires DATABASE_URL into the introspect + buildSchema
// Context pipeline (Kozou v0.1 design spec §8.5).

import type { Handle } from '@sveltejs/kit';

import { buildSchemaContext } from '@kozou/core';
import { introspect } from '@kozou/introspect';

import { SchemaCache } from '$lib/server/schema-cache.js';

const cache = new SchemaCache({
  loader: async () => {
    const connection = process.env.DATABASE_URL;
    if (typeof connection !== 'string' || connection.length === 0) {
      throw new Error(
        'hooks.server: DATABASE_URL is required to introspect the schema.',
      );
    }
    const raw = await introspect({ connection });
    return buildSchemaContext({ raw });
  },
});

export const handle: Handle = async ({ event, resolve }) => {
  event.locals.schema = await cache.get();
  return resolve(event);
};
