// Browser-side fetch for relation-select options.
//
// The DataAdapter is server-only (it carries backend URLs / tokens and is
// kept behind the adapter-boundary eslint rule, Kozou v0.1 design spec
// §18.1.1), so the live picker search runs through the app's own
// `/relation-options` endpoint instead of touching an adapter in the
// browser. The endpoint forwards to DataAdapter.searchRelation on the
// server and returns `{ options }`.
//
// `fetchRelationOptions` matches the DataAdapter.searchRelation signature so
// it can back a minimal `Pick<DataAdapter, 'searchRelation'>` shim that the
// debounced createRelationSearch helper drives unchanged.

import type { RelationOption, SearchRelationParams } from '@kozou/core';

export const RELATION_OPTIONS_PATH = '/relation-options';

export type FetchLike = (url: string) => Promise<Response>;

/** Build the `/relation-options` query string for a relation search. */
export function relationOptionsUrl(
  resource: string,
  params: SearchRelationParams,
): string {
  const query = new URLSearchParams();
  query.set('resource', resource);
  query.set('label', params.labelField);
  if (params.searchFields.length > 0) {
    query.set('fields', params.searchFields.join(','));
  }
  if (params.query.length > 0) query.set('q', params.query);
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  return `${RELATION_OPTIONS_PATH}?${query.toString()}`;
}

export async function fetchRelationOptions(
  fetchFn: FetchLike,
  resource: string,
  params: SearchRelationParams,
): Promise<RelationOption[]> {
  const response = await fetchFn(relationOptionsUrl(resource, params));
  // A non-2xx response (unknown target, backend hiccup) degrades to an empty
  // result so the picker stays usable; the caller keeps any prior options.
  if (!response.ok) return [];
  const body = (await response.json()) as { options?: RelationOption[] };
  return Array.isArray(body.options) ? body.options : [];
}
