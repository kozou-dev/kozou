// Framework-agnostic request handling. Maps a parsed HTTP request to a
// JSON result, independent of node:http (so it can be unit-tested with a
// fake Queryable and driven by the node:http wiring in startApiServer.ts).

import { KozouApiError, errorBody, methodNotAllowed, notFound } from './errors.js';
import type { ResourceLookup, Resource } from './schema-lookup.js';
import {
  buildGetQuery,
  buildListQuery,
  type ListQueryParams,
  type SortDirection,
} from './query-builder.js';

/** Minimal query interface satisfied by both `pg.Pool` and `pg.Client`. */
export type Queryable = {
  query<R extends Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
};

export type ApiHandlerDeps = {
  db: Queryable;
  lookup: ResourceLookup;
  /** Advertised in `GET /`. Optional; defaults to null. */
  version?: string;
};

export type ApiHttpRequest = {
  method: string;
  /** URL-decoded path segments with empty segments removed. */
  segments: string[];
  query: URLSearchParams;
};

export type ApiHttpResult = {
  status: number;
  body: unknown;
};

const RESERVED_PARAMS = new Set(['page', 'pageSize', 'sort', 'search']);

export async function handleApiRequest(
  deps: ApiHandlerDeps,
  req: ApiHttpRequest,
): Promise<ApiHttpResult> {
  try {
    return await route(deps, req);
  } catch (err) {
    if (err instanceof KozouApiError) {
      return { status: err.status, body: errorBody(err.code, err.message) };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { status: 500, body: errorBody('internal', message) };
  }
}

async function route(deps: ApiHandlerDeps, req: ApiHttpRequest): Promise<ApiHttpResult> {
  const { method, segments, query } = req;

  if (segments.length === 0) {
    requireMethod(method, 'GET');
    return {
      status: 200,
      body: { name: 'kozou-api', version: deps.version ?? null, resources: deps.lookup.list() },
    };
  }

  if (segments.length === 1) {
    const resource = resolveOr404(deps.lookup, segments[0]);
    requireMethod(method, 'GET'); // create (POST) arrives in Phase 2
    return listResource(deps, resource, query);
  }

  if (segments.length === 2) {
    const resource = resolveOr404(deps.lookup, segments[0]);
    requireMethod(method, 'GET'); // update/delete arrive in Phase 2
    return getResource(deps, resource, segments[1]);
  }

  throw notFound(`No route for /${segments.join('/')}.`);
}

async function listResource(
  deps: ApiHandlerDeps,
  resource: Resource,
  query: URLSearchParams,
): Promise<ApiHttpResult> {
  const params = parseListParams(query);
  const built = buildListQuery(resource, params);

  const [dataResult, countResult] = await Promise.all([
    deps.db.query<Record<string, unknown>>(built.dataText, built.dataValues),
    deps.db.query<{ total: string | number }>(built.countText, built.countValues),
  ]);

  const total = Number(countResult.rows[0]?.total ?? 0);
  return {
    status: 200,
    body: { rows: dataResult.rows, total, page: built.page, pageSize: built.pageSize },
  };
}

async function getResource(
  deps: ApiHandlerDeps,
  resource: Resource,
  id: string,
): Promise<ApiHttpResult> {
  const built = buildGetQuery(resource, id);
  const result = await deps.db.query<Record<string, unknown>>(built.text, built.values);
  if (result.rows.length === 0) {
    return {
      status: 404,
      body: errorBody('not_found', `No "${resource.name}" row with id "${id}".`),
    };
  }
  return { status: 200, body: result.rows[0] };
}

function resolveOr404(lookup: ResourceLookup, name: string): Resource {
  const resource = lookup.resolve(name);
  if (!resource) {
    throw notFound(`Unknown resource "${name}".`);
  }
  return resource;
}

function requireMethod(method: string, allowed: string): void {
  if (method.toUpperCase() !== allowed) {
    throw methodNotAllowed(`Method ${method} not allowed here; use ${allowed}.`);
  }
}

export function parseListParams(query: URLSearchParams): ListQueryParams {
  const params: ListQueryParams = {};

  const page = parsePositiveInt(query.get('page'));
  if (page !== undefined) params.page = page;

  const pageSize = parsePositiveInt(query.get('pageSize'));
  if (pageSize !== undefined) params.pageSize = pageSize;

  const search = query.get('search');
  if (search !== null && search.length > 0) params.search = search;

  const sort = parseSort(query.get('sort'));
  if (sort.length > 0) params.sort = sort;

  const filters: Record<string, string> = {};
  for (const [key, value] of query.entries()) {
    if (RESERVED_PARAMS.has(key)) continue;
    filters[key] = value; // last value wins on repeated keys
  }
  if (Object.keys(filters).length > 0) params.filters = filters;

  return params;
}

function parsePositiveInt(raw: string | null): number | undefined {
  if (raw === null || raw.length === 0) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  return n;
}

function parseSort(raw: string | null): { field: string; order: SortDirection }[] {
  if (raw === null || raw.length === 0) return [];
  const result: { field: string; order: SortDirection }[] = [];
  for (const token of raw.split(',')) {
    const trimmed = token.trim();
    if (trimmed.length === 0) continue;
    const dot = trimmed.lastIndexOf('.');
    if (dot > 0) {
      const suffix = trimmed.slice(dot + 1).toLowerCase();
      if (suffix === 'asc' || suffix === 'desc') {
        result.push({ field: trimmed.slice(0, dot), order: suffix });
        continue;
      }
    }
    result.push({ field: trimmed, order: 'asc' });
  }
  return result;
}
