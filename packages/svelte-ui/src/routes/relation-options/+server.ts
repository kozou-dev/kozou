// Relation-select live-search endpoint.
//
// The browser picker cannot call the server-only DataAdapter directly (it is
// kept behind the adapter-boundary rule), so
// it queries this endpoint, which forwards to DataAdapter.searchRelation and
// returns `{ options: RelationOption[] }`. Request validation (known target
// table, real label / search columns) lives in `searchRelationOptions` so it
// is unit-tested independently of the HTTP layer.

import { json } from '@sveltejs/kit';

import { getAdapter } from '$lib/server/adapter.js';
import { searchRelationOptions } from '$lib/server/relation-options.js';

import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url, locals }) => {
  const options = await searchRelationOptions(
    locals.schema,
    getAdapter(locals.schema),
    {
      resource: url.searchParams.get('resource'),
      label: url.searchParams.get('label'),
      fields: url.searchParams.get('fields'),
      query: url.searchParams.get('q'),
      limit: url.searchParams.get('limit'),
    },
  );
  return json({ options });
};
