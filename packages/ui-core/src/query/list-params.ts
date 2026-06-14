// URL search-params <-> DataAdapter ListParams marshalling.
//
// Keeping the parser in a pure module lets the table route stay
// declarative and lets us unit-test the URL contract without
// booting SvelteKit. The wire format is:
//
//   ?q=<text>                  -> case-insensitive search across `searchFields`
//   ?sort=col:asc,col2:desc    -> SortSpec[] (one or many)
//   ?page=<n>                  -> 1-based page index, default 1
//   ?pageSize=<m>              -> rows per page, default 50

import type { ListParams, SortSpec } from '@kozou/core';

const DEFAULT_PAGE = 1;
export const DEFAULT_PAGE_SIZE = 50;

export interface ParseListParamsInput {
  url: URL;
  /** Columns whose values can be ilike'd. Empty -> `q` is ignored. */
  searchFields: string[];
  defaultPageSize?: number;
}

export interface ParsedListParams extends ListParams {
  /** The verbatim text from `?q=` so the UI can rehydrate the search box. */
  search: string;
  filters: Record<string, unknown>;
  sort: SortSpec[];
  page: number;
  pageSize: number;
}

export function parseListParamsFromUrl(
  input: ParseListParamsInput,
): ParsedListParams {
  const { url, searchFields } = input;
  const defaultPageSize = input.defaultPageSize ?? DEFAULT_PAGE_SIZE;
  const params = url.searchParams;

  const q = params.get('q') ?? '';
  const sort = parseSortSpecs(params.get('sort'));
  const page = parsePositiveInt(params.get('page'), DEFAULT_PAGE);
  const pageSize = parsePositiveInt(params.get('pageSize'), defaultPageSize);

  const filters: Record<string, unknown> = {};
  if (q.length > 0 && searchFields.length > 0) {
    filters.__or = searchFields
      .map((field) => `${field}.ilike.*${q}*`)
      .join(',');
  }

  return { search: q, filters, sort, page, pageSize };
}

function parseSortSpecs(raw: string | null): SortSpec[] {
  if (raw === null || raw.length === 0) return [];
  return raw
    .split(',')
    .map((entry) => parseSingleSort(entry))
    .filter((entry): entry is SortSpec => entry !== null);
}

function parseSingleSort(raw: string): SortSpec | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const [field, orderRaw] = trimmed.split(':');
  if (!field) return null;
  const order = orderRaw === 'desc' ? 'desc' : 'asc';
  return { field, order };
}

function parsePositiveInt(raw: string | null, fallback: number): number {
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.floor(n);
}
