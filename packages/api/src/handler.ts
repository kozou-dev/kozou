// Framework-agnostic request handling. Maps a parsed HTTP request to a
// JSON result, independent of node:http (so it can be unit-tested with a
// fake Queryable and driven by the node:http wiring in startApiServer.ts).

import {
  KozouApiError,
  badRequest,
  errorBody,
  mapDatabaseError,
  methodNotAllowed,
  notFound,
} from './errors.js';
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
  type Filter,
  type FilterOperator,
} from './query-builder.js';
import { parseEmbedParam, resolveEmbedSpec } from './embed.js';
import { buildRpcCall, shapeRpcResult, type FunctionLookup } from './rpc.js';

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
  /** Registry of exposed RPC functions (issue #103). Absent = no `/rpc/`
   *  surface (no function was exposed); a `/rpc/` request then 404s. */
  functions?: FunctionLookup;
  /** Advertised in `GET /`. Optional; defaults to null. */
  version?: string;
  /** Prebuilt OpenAPI document served at `GET /openapi.json`. */
  openapi?: Record<string, unknown>;
  /** Prefix for server-side error log lines. Default: '[@kozou/api]'. */
  logPrefix?: string;
};

export type ApiHttpRequest = {
  method: string;
  /** URL-decoded path segments with empty segments removed. */
  segments: string[];
  query: URLSearchParams;
  /** Parsed JSON request body (create / update). Undefined when absent. */
  body?: unknown;
  /** Raw request headers (node lower-cases the keys). Used for auth; absent on
   *  the zero-auth path. */
  headers?: Record<string, string | string[] | undefined>;
};

export type ApiHttpResult = {
  status: number;
  body: unknown;
};

/** List query keys consumed as controls (not column filters). Shared with the
 *  OpenAPI generator so it never advertises a control key as a filterable
 *  column. */
export const RESERVED_PARAMS = new Set(['page', 'pageSize', 'sort', 'search', 'embed']);

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
    // The raw error (a database message, a stack, a driver detail) can carry
    // internal information such as schema or helper-function names; it goes
    // to the server log, never into the response body.
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${deps.logPrefix ?? '[@kozou/api]'} request failed: ${detail}\n`);
    const mapped = mapDatabaseError(err);
    if (mapped !== null) {
      return { status: mapped.status, body: errorBody(mapped.code, mapped.message) };
    }
    return { status: 500, body: errorBody('internal', 'Internal server error.') };
  }
}

async function route(deps: ApiHandlerDeps, req: ApiHttpRequest): Promise<ApiHttpResult> {
  const { method, segments, query } = req;
  const m = method.toUpperCase();

  if (segments.length === 0) {
    requireMethod(method, 'GET');
    return {
      status: 200,
      body: {
        name: 'kozou-api',
        version: deps.version ?? null,
        resources: deps.lookup.list(),
        functions: deps.functions?.list() ?? [],
      },
    };
  }

  // RPC namespace (issue #103): `POST /rpc/<schema>.<fn>`. The function is
  // addressed by its schema-qualified identity (§5.0), which contains a dot, so
  // it never collides with a `/<resource>/<id>` item route. Reserved as
  // POST-only (volatility does not split GET/POST in v1, §2). `rpc` is a
  // reserved top-level segment: a table literally named `rpc` is still
  // reachable by its qualified name (`/<schema>.rpc/<id>`), but its bare-name
  // item routes are shadowed by this namespace.
  if (segments.length === 2 && segments[0] === 'rpc') {
    if (m !== 'POST') {
      throw methodNotAllowed(`Method ${method} not allowed on /rpc; use POST.`);
    }
    return callFunction(deps, segments[1]!, req.body);
  }

  if (segments.length === 1 && segments[0] === 'openapi.json') {
    requireMethod(method, 'GET');
    if (!deps.openapi) {
      throw notFound('OpenAPI document is not configured.');
    }
    return { status: 200, body: deps.openapi };
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
    if (m === 'GET') return getResource(deps, resource, id, query);
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
  const embed = resolveEmbedSpec(resource, parseEmbedParam(query.get('embed')), deps.lookup);
  const built = buildListQuery(resource, { ...params, embed });

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
  query: URLSearchParams,
): Promise<ApiHttpResult> {
  const embed = resolveEmbedSpec(resource, parseEmbedParam(query.get('embed')), deps.lookup);
  const built = buildGetQuery(resource, id, embed);
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
  // A single-column key yields a scalar id; a composite key yields an array
  // of components in primary-key declaration order (a valid item id for the
  // target resource).
  const keyColumns = built.primaryKeys ?? [built.primaryKey];
  const options = result.rows.map((row) => ({
    id:
      keyColumns.length === 1
        ? (row[keyColumns[0]] as string | number)
        : keyColumns.map((column) => row[column] as string | number),
    label: String(row[built.labelField] ?? ''),
  }));
  return { status: 200, body: { options } };
}

async function callFunction(
  deps: ApiHandlerDeps,
  qualifiedName: string,
  body: unknown,
): Promise<ApiHttpResult> {
  const fn = deps.functions?.resolve(qualifiedName);
  if (fn === undefined) {
    // Same shape as an unknown resource: a function that was not exposed is
    // indistinguishable from one that does not exist (no enumeration channel).
    throw notFound(`Unknown function "${qualifiedName}".`);
  }
  const built = buildRpcCall(fn, requireRpcBody(body));
  // Runs on deps.db — under the request's role + claims in the authed path — so
  // PostgreSQL's EXECUTE privilege and the function's own RLS apply. A 42501
  // (no EXECUTE / RLS denial) maps to 403 in the handler's error classifier.
  const result = await deps.db.query<Record<string, unknown>>(built.text, built.values);
  return shapeRpcResult(built.returns, result.rows);
}

/** RPC body: a JSON object of named arguments. An absent body is an empty
 *  argument set (valid for a no-argument or all-default function). */
function requireRpcBody(body: unknown): Record<string, unknown> {
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('RPC request body must be a JSON object of named arguments.');
  }
  return body as Record<string, unknown>;
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

  // Each non-reserved query entry is one horizontal filter. Repeated keys are
  // kept (not collapsed) so a column can carry several filters — e.g. a
  // `?price=gte.10&price=lte.20` range — that combine with AND.
  const filters: Filter[] = [];
  for (const [key, value] of query.entries()) {
    if (RESERVED_PARAMS.has(key)) continue;
    filters.push(parseFilter(key, value));
  }
  if (filters.length > 0) params.filters = filters;

  return params;
}

const FILTER_OPERATORS = new Set<FilterOperator>([
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'like',
  'ilike',
  'in',
  'is',
]);

function isFilterOperator(token: string): token is FilterOperator {
  return (FILTER_OPERATORS as Set<string>).has(token);
}

/**
 * Parse one `?<column>=<raw>` entry into a structured {@link Filter}.
 *
 * Grammar: `<op>.<value>` where `op` is one of the known operators; the split
 * is on the FIRST `.` only (so values may contain dots). A value whose prefix
 * is not a known operator — or which has no leading `op.` at all — is treated
 * as an equality match, keeping the legacy `?<column>=<value>` form working.
 * The split uses `indexOf`, not a regular expression (ReDoS-safe).
 */
function parseFilter(column: string, raw: string): Filter {
  const dot = raw.indexOf('.');
  if (dot > 0) {
    const maybeOp = raw.slice(0, dot);
    if (isFilterOperator(maybeOp)) {
      return buildFilter(column, maybeOp, raw.slice(dot + 1));
    }
  }
  return { column, op: 'eq', value: raw };
}

function buildFilter(column: string, op: FilterOperator, rhs: string): Filter {
  if (op === 'in') {
    if (rhs.length < 2 || rhs[0] !== '(' || rhs[rhs.length - 1] !== ')') {
      throw badRequest(`Filter "${column}=in.${rhs}" must look like "in.(v1,v2,...)".`);
    }
    const inner = rhs.slice(1, -1);
    // Note: values cannot contain a comma (no quoting is supported in v1.0).
    const values = inner.length === 0 ? [] : inner.split(',');
    return { column, op: 'in', values };
  }
  if (op === 'is') {
    if (rhs === 'null' || rhs === 'notnull' || rhs === 'true' || rhs === 'false') {
      return { column, op: 'is', keyword: rhs };
    }
    throw badRequest(
      `Filter "${column}=is.${rhs}" must be one of is.null, is.notnull, is.true, is.false.`,
    );
  }
  return { column, op, value: rhs };
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
