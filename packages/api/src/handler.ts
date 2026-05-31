// Framework-agnostic request handling. Maps a parsed HTTP request to a
// JSON result, independent of node:http (so it can be unit-tested with a
// fake Queryable and driven by the node:http wiring in startApiServer.ts).

import { KozouApiError, badRequest, errorBody, methodNotAllowed, notFound } from './errors.js';
import type { ResourceLookup, Resource } from './schema-lookup.js';
import {
  buildGetQuery,
  buildListQuery,
  buildInsertQuery,
  buildUpdateQuery,
  buildDeleteQuery,
  buildRelationOptionsQuery,
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
  /** Parsed JSON request body (create / update). Undefined when absent. */
  body?: unknown;
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
  const m = method.toUpperCase();

  if (segments.length === 0) {
    requireMethod(method, 'GET');
    return {
      status: 200,
      body: { name: 'kozou-api', version: deps.version ?? null, resources: deps.lookup.list() },
    };
  }

  if (segments.length === 1) {
    const resource = resolveOr404(deps.lookup, segments[0]);
    if (m === 'GET') {
      return query.get('as') === 'options'
        ? relationOptions(deps, resource, query)
        : listResource(deps, resource, query);
    }
    if (m === 'POST') return createResource(deps, resource, req.body);
    throw methodNotAllowed(`Method ${method} not allowed on a collection; use GET or POST.`);
  }

  if (segments.length === 2) {
    const resource = resolveOr404(deps.lookup, segments[0]);
    const id = segments[1];
    if (m === 'GET') return getResource(deps, resource, id);
    if (m === 'PATCH') return updateResource(deps, resource, id, req.body);
    if (m === 'DELETE') return deleteResource(deps, resource, id);
    throw methodNotAllowed(`Method ${method} not allowed on an item; use GET, PATCH, or DELETE.`);
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
    return notFoundResult(resource, id);
  }
  return { status: 200, body: result.rows[0] };
}

async function createResource(
  deps: ApiHandlerDeps,
  resource: Resource,
  body: unknown,
): Promise<ApiHttpResult> {
  requireWritable(resource);
  const built = buildInsertQuery(resource, requireObjectBody(body));
  const result = await deps.db.query<Record<string, unknown>>(built.text, built.values);
  return { status: 201, body: result.rows[0] };
}

async function updateResource(
  deps: ApiHandlerDeps,
  resource: Resource,
  id: string,
  body: unknown,
): Promise<ApiHttpResult> {
  requireWritable(resource);
  const built = buildUpdateQuery(resource, id, requireObjectBody(body));
  const result = await deps.db.query<Record<string, unknown>>(built.text, built.values);
  if (result.rows.length === 0) return notFoundResult(resource, id);
  return { status: 200, body: result.rows[0] };
}

async function deleteResource(
  deps: ApiHandlerDeps,
  resource: Resource,
  id: string,
): Promise<ApiHttpResult> {
  requireWritable(resource);
  const built = buildDeleteQuery(resource, id);
  const result = await deps.db.query<Record<string, unknown>>(built.text, built.values);
  if (result.rows.length === 0) return notFoundResult(resource, id);
  return { status: 200, body: result.rows[0] };
}

async function relationOptions(
  deps: ApiHandlerDeps,
  resource: Resource,
  query: URLSearchParams,
): Promise<ApiHttpResult> {
  const labelField = query.get('label');
  if (labelField === null || labelField.length === 0) {
    throw badRequest('Relation options require a "label" query parameter.');
  }
  const fieldsRaw = query.get('fields');
  const searchFields = fieldsRaw
    ? fieldsRaw.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
    : [];
  const built = buildRelationOptionsQuery(resource, {
    labelField,
    searchFields,
    query: query.get('q') ?? undefined,
    limit: parsePositiveInt(query.get('limit')),
  });
  const result = await deps.db.query<Record<string, unknown>>(built.text, built.values);
  const options = result.rows.map((row) => ({
    id: row[built.primaryKey] as string | number,
    label: String(row[built.labelField] ?? ''),
  }));
  return { status: 200, body: { options } };
}

function notFoundResult(resource: Resource, id: string): ApiHttpResult {
  return {
    status: 404,
    body: errorBody('not_found', `No "${resource.name}" row with id "${id}".`),
  };
}

function requireWritable(resource: Resource): void {
  if (resource.kind === 'view') {
    throw methodNotAllowed(`Resource "${resource.name}" is a read-only view.`);
  }
}

function requireObjectBody(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('Request body must be a JSON object.');
  }
  return body as Record<string, unknown>;
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
