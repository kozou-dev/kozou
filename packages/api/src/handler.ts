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
  type CountMode,
} from './query-builder.js';
import { parseEmbedParam, resolveEmbedSpec } from './embed.js';
import { buildRpcCall, shapeRpcResult, type FunctionLookup } from './rpc.js';

// The minimal query interface (satisfied by both `pg.Pool` and `pg.Client`)
// lives in @kozou/core so the role-transaction envelope and the MCP execution
// surface share one definition; re-exported here for the package's consumers.
import type { Queryable } from '@kozou/core';
export type { Queryable };

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
// `count` is a control key like `page`/`sort` (issue #177): it selects the
// count strategy, not a column filter. As with the other control keys, this
// shadows any column of the same name from the `<col>=<op>.<value>` grammar.
export const RESERVED_PARAMS = new Set(['page', 'pageSize', 'sort', 'search', 'embed', 'count']);

const COUNT_MODES = new Set<CountMode>(['exact', 'estimated', 'none']);

/** Parse the `?count=` control into a {@link CountMode}, 400-ing on anything
 *  outside the allowed set so a typo is a clear client error. */
function parseCountMode(raw: string): CountMode {
  if (!(COUNT_MODES as Set<string>).has(raw)) {
    throw badRequest(`Invalid count mode "${raw}"; use one of exact, estimated, none.`);
  }
  return raw as CountMode;
}

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
  // addressed by its schema-qualified identity, which contains a dot, so
  // it never collides with a `/<resource>/<id>` item route. Reserved as
  // POST-only (volatility does not split GET/POST in v1). `rpc` is a
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

  // Run the page query and the count concurrently. `none` skips the count
  // (total is null); `estimated` reads the planner's row estimate from EXPLAIN;
  // `exact` is the precise count(*). Default is `exact`, preserving the wire.
  const dataPromise = deps.db.query<Record<string, unknown>>(built.dataText, built.dataValues);
  // `countMode` / `estimateText` are optional on the public type for back-compat
  // (buildListQuery always sets them); normalize to the exact count otherwise.
  const countMode = built.countMode ?? 'exact';
  const totalPromise: Promise<number | null> =
    countMode === 'none'
      ? Promise.resolve(null)
      : countMode === 'estimated' && built.estimateText !== undefined
        ? deps.db
            .query<Record<string, unknown>>(built.estimateText, built.countValues)
            .then(estimateFromExplain)
        : deps.db
            .query<{ total: string | number }>(built.countText, built.countValues)
            .then((r) => Number(r.rows[0]?.total ?? 0));

  const [dataResult, total] = await Promise.all([dataPromise, totalPromise]);
  return {
    status: 200,
    body: { rows: dataResult.rows, total, page: built.page, pageSize: built.pageSize },
  };
}

/** Read the planner's estimated output-row count from an `EXPLAIN (FORMAT JSON)`
 *  result. The single row carries a `QUERY PLAN` column (node-postgres parses
 *  the json automatically) whose top plan node holds `Plan Rows`. Falls back to
 *  0 if the shape is ever unexpected. */
function estimateFromExplain(result: { rows: Record<string, unknown>[] }): number {
  const plan = result.rows[0]?.['QUERY PLAN'] as
    | { Plan?: { 'Plan Rows'?: number } }[]
    | undefined;
  const rows = plan?.[0]?.Plan?.['Plan Rows'];
  return typeof rows === 'number' && Number.isFinite(rows) ? Math.max(0, Math.round(rows)) : 0;
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

  const count = query.get('count');
  if (count !== null) params.count = parseCountMode(count);

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
    return { column, op: 'in', values: splitInList(rhs.slice(1, -1), column) };
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

/**
 * Split an `in.(...)` inner list on its separator commas, with optional
 * double-quoting so a value may itself contain a comma (issue #77). A value
 * that begins with `"` is read up to its matching closing `"`; inside the
 * quotes a comma is literal, `\"` is a literal quote and `\\` a literal
 * backslash. A value that does NOT begin with a quote is taken verbatim up to
 * the next comma (an embedded `"` stays literal), so every list that parsed
 * before quoting was introduced still parses identically — quoting is opt-in by
 * a leading quote, and a percent-encoded comma still decodes to a separator, so
 * existing requests are unaffected. Linear character scan (no regex), per this
 * module's ReDoS-avoidance convention.
 */
function splitInList(inner: string, column: string): string[] {
  if (inner.length === 0) return [];
  const values: string[] = [];
  let i = 0;
  for (;;) {
    if (inner[i] === '"') {
      // Quoted value: read to the matching unescaped closing quote.
      let value = '';
      i += 1;
      let closed = false;
      while (i < inner.length) {
        const ch = inner[i]!;
        if (ch === '\\' && (inner[i + 1] === '"' || inner[i + 1] === '\\')) {
          value += inner[i + 1];
          i += 2;
          continue;
        }
        if (ch === '"') {
          closed = true;
          i += 1;
          break;
        }
        value += ch;
        i += 1;
      }
      if (!closed) {
        throw badRequest(
          `Filter "${column}=in.(...)" has an unterminated quoted value (close it with ").`,
        );
      }
      if (i < inner.length && inner[i] !== ',') {
        throw badRequest(
          `Filter "${column}=in.(...)" has unexpected text after a quoted value; ` +
            'a quoted value must be followed by a comma or the closing paren.',
        );
      }
      values.push(value);
    } else {
      // Unquoted value: taken verbatim up to the next comma.
      const comma = inner.indexOf(',', i);
      if (comma === -1) {
        values.push(inner.slice(i));
        break;
      }
      values.push(inner.slice(i, comma));
      i = comma + 1;
      continue;
    }
    // After a quoted value we are at a separator comma or the end of the list.
    if (i >= inner.length) break;
    i += 1; // consume the separator comma
    if (i >= inner.length) {
      values.push(''); // a trailing comma → a final empty value
      break;
    }
  }
  return values;
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
