// Shared client-side helpers for the list / view route tables.
//
// `buildHref` / `buildSortHref` / `formatCell` were duplicated verbatim
// in the `/tables/[table]` and `/views/[view]` route components. This
// module is their single source so the shared `ListTable.svelte` and
// both routes agree on the URL contract defined in
// `query/list-params.ts`. See Kozou v0.1 design spec §8.3.2 / §16.1.1 B.

import type { SortSpec } from '@kozou/core';

import { DEFAULT_PAGE_SIZE } from '$lib/query/list-params.js';

/** The client-visible slice of `ParsedListParams` the routes hand to
 *  the template — the `filters` field stays server-side. */
export interface ListViewParams {
  search: string;
  sort: SortSpec[];
  page: number;
  pageSize: number;
}

/** Rebuild the current list URL with `overrides` applied (a `null`
 *  override deletes that key). Mirrors the wire format parsed by
 *  `parseListParamsFromUrl`; returns `.` when no params remain so the
 *  link points at the bare route. */
export function buildHref(
  params: ListViewParams,
  overrides: Record<string, string | null> = {},
): string {
  const sp = new URLSearchParams();
  if (params.search.length > 0) sp.set('q', params.search);
  if (params.sort.length > 0) {
    sp.set('sort', params.sort.map((s) => `${s.field}:${s.order}`).join(','));
  }
  if (params.page > 1) sp.set('page', String(params.page));
  if (params.pageSize !== DEFAULT_PAGE_SIZE) {
    sp.set('pageSize', String(params.pageSize));
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) sp.delete(key);
    else sp.set(key, value);
  }
  const query = sp.toString();
  return query.length > 0 ? `?${query}` : '.';
}

/** Header link target that toggles the sort order for `field` (asc <->
 *  desc, defaulting to asc) and resets back to page 1. */
export function buildSortHref(params: ListViewParams, field: string): string {
  const current = params.sort.find((s) => s.field === field)?.order;
  const next = current === 'asc' ? 'desc' : 'asc';
  return buildHref(params, { sort: `${field}:${next}`, page: null });
}

/** Stringify a cell value for the list table: objects render as JSON,
 *  `null` / `undefined` render as the empty string. */
export function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
