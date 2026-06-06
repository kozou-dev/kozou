// PostgrestDataAdapter — DataAdapter implementation that speaks PostgREST 12+.
// See Kozou v0.1 design spec §4.4 (DataAdapter interface) and §8.5.
//
// Sub-step 6-D ships list() + get() + the shared request plumbing.
// Sub-step 6-E ships create() / update() / delete() / searchRelation().
//
// License-check note: this file is whitelisted in
// .github/workflows/license-check.yml so the class names below
// (PostgrestDataAdapter, PostgrestAdapterError, PostgrestAdapterOptions)
// do not trip the metadata-integrity grep. The file mentions PostgREST
// by name *only* to interoperate with the PostgREST HTTP surface; no
// PostgREST source code is bundled here.

import type {
  DataAdapter,
  ListParams,
  ListResult,
  RelationOption,
  ResourceId,
  SearchRelationParams,
  SortSpec,
} from '@kozou/core';

import { AdapterError, type AdapterErrorInit } from './errors.js';
import type { FetchLike } from './types.js';

const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_SCHEMA = 'public';
const DEFAULT_PRIMARY_KEY = 'id';
const DEFAULT_RELATION_LIMIT = 20;

const OR_FILTER_KEY = '__or';

// The horizontal filter operators the in-house API list endpoint accepts
// (Kozou v1.0 dev spec §4). The REST surface this adapter targets shares the
// same `col=op.value` grammar natively, so an already-prefixed filter value
// is forwarded verbatim; a bare value defaults to equality for backward
// compatibility. Detection uses indexOf, not a regex (ReDoS-safe).
const FILTER_OPERATORS = new Set([
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

/** A single key column, the ordered columns of a composite key, or a
 *  function computing either from the resource name. */
export type PostgrestPrimaryKeyResolver =
  | string
  | string[]
  | ((resource: string) => string | string[]);

export interface PostgrestAdapterOptions {
  /** Base URL of the PostgREST server (trailing slash is stripped). */
  baseUrl: string;
  /** Default DB schema; non-default schemas are addressed via the
   *  resource string `<schema>.<table>` plus per-request profile headers. */
  defaultSchema?: string;
  /** Primary key resolver. A plain string is used for every resource;
   *  a function lets callers compute the column from the resource name. */
  primaryKey?: PostgrestPrimaryKeyResolver;
  /** Static headers merged into every request (e.g. Authorization). */
  headers?: Record<string, string>;
  /** Fetch override; defaults to `globalThis.fetch`. Injection point for tests. */
  fetch?: FetchLike;
  /** Page size used when ListParams.pageSize is omitted. */
  defaultPageSize?: number;
}

export class PostgrestAdapterError extends AdapterError {
  constructor(init: AdapterErrorInit) {
    super(init);
    this.name = 'PostgrestAdapterError';
  }
}

export class PostgrestDataAdapter implements DataAdapter {
  private readonly baseUrl: string;
  private readonly defaultSchema: string;
  private readonly resolvePrimaryKey: (resource: string) => string | string[];
  private readonly staticHeaders: Record<string, string>;
  private readonly fetchImpl: FetchLike;
  private readonly defaultPageSize: number;

  constructor(opts: PostgrestAdapterOptions) {
    if (typeof opts.baseUrl !== 'string' || opts.baseUrl.length === 0) {
      throw adapterConfigError('PostgrestDataAdapter: `baseUrl` is required.');
    }
    this.baseUrl = stripTrailingSlash(opts.baseUrl);
    this.defaultSchema = opts.defaultSchema ?? DEFAULT_SCHEMA;
    this.resolvePrimaryKey = makePrimaryKeyResolver(opts.primaryKey);
    this.staticHeaders = { ...(opts.headers ?? {}) };
    this.defaultPageSize = opts.defaultPageSize ?? DEFAULT_PAGE_SIZE;

    const resolvedFetch = opts.fetch ?? (globalThis.fetch as FetchLike | undefined);
    if (typeof resolvedFetch !== 'function') {
      throw adapterConfigError(
        'PostgrestDataAdapter: a `fetch` implementation is required (none injected, none on globalThis).',
      );
    }
    this.fetchImpl = resolvedFetch;
  }

  async list(resource: string, params: ListParams): Promise<ListResult> {
    const { schema, table } = splitResource(resource, this.defaultSchema);
    const pageSize = params.pageSize ?? this.defaultPageSize;
    const page = params.page ?? 1;
    const offset = (page - 1) * pageSize;

    const query = new URLSearchParams();
    appendFilters(query, params.filters);
    appendOrder(query, params.sort);
    query.set('limit', String(pageSize));
    query.set('offset', String(offset));

    const url = `${this.baseUrl}/${encodeURIComponent(table)}?${query.toString()}`;
    const headers: Record<string, string> = {
      ...this.staticHeaders,
      Accept: 'application/json',
      Prefer: 'count=exact',
    };
    addProfileHeader(headers, schema, this.defaultSchema, 'read');

    const response = await this.send('GET', url, headers, undefined);
    await assertOk(response, url);
    const rows = (await readJson(response, url)) as Record<string, unknown>[];
    const total = parseContentRangeTotal(
      response.headers.get('content-range'),
      rows.length,
    );

    return { rows, total, page, pageSize };
  }

  async get(
    resource: string,
    id: ResourceId,
  ): Promise<Record<string, unknown>> {
    const { schema, table } = splitResource(resource, this.defaultSchema);

    const query = new URLSearchParams();
    this.appendKeyEquals(query, resource, id);
    query.set('limit', '1');

    const url = `${this.baseUrl}/${encodeURIComponent(table)}?${query.toString()}`;
    const headers: Record<string, string> = {
      ...this.staticHeaders,
      Accept: 'application/vnd.pgrst.object+json',
    };
    addProfileHeader(headers, schema, this.defaultSchema, 'read');

    const response = await this.send('GET', url, headers, undefined);
    await assertOk(response, url);
    return (await readJson(response, url)) as Record<string, unknown>;
  }

  async create(
    resource: string,
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const { schema, table } = splitResource(resource, this.defaultSchema);
    const url = `${this.baseUrl}/${encodeURIComponent(table)}`;
    const headers = this.mutationHeaders(schema);
    const response = await this.send('POST', url, headers, JSON.stringify(data));
    await assertOk(response, url);
    return (await readJson(response, url)) as Record<string, unknown>;
  }

  async update(
    resource: string,
    id: ResourceId,
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const { schema, table } = splitResource(resource, this.defaultSchema);
    const query = new URLSearchParams();
    this.appendKeyEquals(query, resource, id);
    const url = `${this.baseUrl}/${encodeURIComponent(table)}?${query.toString()}`;
    const headers = this.mutationHeaders(schema);
    const response = await this.send('PATCH', url, headers, JSON.stringify(data));
    await assertOk(response, url);
    return (await readJson(response, url)) as Record<string, unknown>;
  }

  async delete(resource: string, id: ResourceId): Promise<void> {
    const { schema, table } = splitResource(resource, this.defaultSchema);
    const query = new URLSearchParams();
    this.appendKeyEquals(query, resource, id);
    const url = `${this.baseUrl}/${encodeURIComponent(table)}?${query.toString()}`;
    const headers: Record<string, string> = { ...this.staticHeaders };
    addProfileHeader(headers, schema, this.defaultSchema, 'write');
    const response = await this.send('DELETE', url, headers, undefined);
    await assertOk(response, url);
  }

  async searchRelation(
    resource: string,
    params: SearchRelationParams,
  ): Promise<RelationOption[]> {
    const { schema, table } = splitResource(resource, this.defaultSchema);
    // relation-select targets a single-column key in v1.0 (a composite key as
    // a relation target is a fast-follow, Kozou v1.0 dev spec §3.5 / §5.2), so
    // the option id uses the first key column.
    const primaryKey = keyColumns(this.resolvePrimaryKey(resource))[0];
    const limit = params.limit ?? DEFAULT_RELATION_LIMIT;

    const query = new URLSearchParams();
    query.set('select', `${primaryKey},${params.labelField}`);
    if (params.query.length > 0 && params.searchFields.length > 0) {
      const orExpr = params.searchFields
        .map((field) => `${field}.ilike.*${params.query}*`)
        .join(',');
      query.set('or', `(${orExpr})`);
    }
    query.set('limit', String(limit));

    const url = `${this.baseUrl}/${encodeURIComponent(table)}?${query.toString()}`;
    const headers: Record<string, string> = {
      ...this.staticHeaders,
      Accept: 'application/json',
    };
    addProfileHeader(headers, schema, this.defaultSchema, 'read');

    const response = await this.send('GET', url, headers, undefined);
    await assertOk(response, url);
    const rows = (await readJson(response, url)) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: row[primaryKey] as string | number,
      label: String(row[params.labelField] ?? ''),
    }));
  }

  /**
   * Append the per-column equality filters that address a row by id. A
   * composite key expands to `?col0=eq.v0&col1=eq.v1` in `primaryKey`
   * declaration order (Kozou v1.0 dev spec §3.7); a single-column key keeps
   * the `?col=eq.value` form. The id component count must match the key
   * arity (else a config error, surfacing a wiring mismatch).
   */
  private appendKeyEquals(
    query: URLSearchParams,
    resource: string,
    id: ResourceId,
  ): void {
    const columns = keyColumns(this.resolvePrimaryKey(resource));
    const values = asResourceIdArray(id);
    if (columns.length !== values.length) {
      throw adapterConfigError(
        `PostgrestDataAdapter: resource "${resource}" has a ${columns.length}-column ` +
          `primary key (${columns.join(', ')}) but ${values.length} id ` +
          `component(s) were supplied.`,
      );
    }
    columns.forEach((column, i) => {
      query.set(column, `eq.${serializeFilterValue(values[i])}`);
    });
  }

  private mutationHeaders(schema: string): Record<string, string> {
    const headers: Record<string, string> = {
      ...this.staticHeaders,
      Accept: 'application/vnd.pgrst.object+json',
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    };
    addProfileHeader(headers, schema, this.defaultSchema, 'write');
    return headers;
  }

  private async send(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    headers: Record<string, string>,
    body: string | undefined,
  ): Promise<Response> {
    try {
      return await this.fetchImpl(url, { method, headers, body });
    } catch (cause) {
      throw new PostgrestAdapterError({
        message: `PostgrestDataAdapter: ${method} ${url} failed before reaching the server: ${(cause as Error).message}`,
        status: 0,
        url,
        responseBody: null,
        code: 'network',
      });
    }
  }
}

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

function makePrimaryKeyResolver(
  pk: PostgrestPrimaryKeyResolver | undefined,
): (resource: string) => string | string[] {
  if (pk === undefined) return () => DEFAULT_PRIMARY_KEY;
  if (typeof pk === 'function') return pk;
  return () => pk;
}

/** Normalize a resolver result to the ordered list of key columns. */
function keyColumns(pk: string | string[]): string[] {
  return Array.isArray(pk) ? pk : [pk];
}

/** Normalize a ResourceId to the ordered list of key values. */
function asResourceIdArray(id: ResourceId): Array<string | number> {
  return Array.isArray(id) ? id : [id];
}

function splitResource(
  resource: string,
  defaultSchema: string,
): { schema: string; table: string } {
  const idx = resource.indexOf('.');
  if (idx === -1) {
    return { schema: defaultSchema, table: resource };
  }
  return {
    schema: resource.slice(0, idx),
    table: resource.slice(idx + 1),
  };
}

function appendFilters(
  query: URLSearchParams,
  filters: Record<string, unknown> | undefined,
): void {
  if (!filters) return;
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined) continue;
    if (key === OR_FILTER_KEY) {
      query.set('or', `(${serializeOrExpression(value)})`);
      continue;
    }
    // A value already carrying a known operator prefix (`gt.5`, `in.(a,b)`,
    // `is.null`, ...) is the REST surface's native grammar, so it is
    // forwarded verbatim; a bare value defaults to equality (Kozou v1.0 dev
    // spec §4, kept consistent with the in-house API adapter).
    if (typeof value === 'string' && hasOperatorPrefix(value)) {
      query.set(key, value);
      continue;
    }
    query.set(key, `eq.${serializeFilterValue(value)}`);
  }
}

/** Whether a filter value begins with a `<op>.` prefix from the known
 *  operator set. Split on the first `.` via indexOf (no regex, ReDoS-safe). */
function hasOperatorPrefix(value: string): boolean {
  const dot = value.indexOf('.');
  return dot > 0 && FILTER_OPERATORS.has(value.slice(0, dot));
}

function serializeOrExpression(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(String).join(',');
  return String(value);
}

function serializeFilterValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  return String(value);
}

function appendOrder(
  query: URLSearchParams,
  sort: SortSpec[] | undefined,
): void {
  if (!sort || sort.length === 0) return;
  query.set('order', sort.map((s) => `${s.field}.${s.order}`).join(','));
}

function addProfileHeader(
  headers: Record<string, string>,
  schema: string,
  defaultSchema: string,
  direction: 'read' | 'write',
): void {
  if (schema === defaultSchema) return;
  headers[direction === 'read' ? 'Accept-Profile' : 'Content-Profile'] = schema;
}

function parseContentRangeTotal(header: string | null, fallback: number): number {
  if (!header) return fallback;
  const match = header.match(/\/(\d+)$/);
  if (!match) return fallback;
  return Number(match[1]);
}

async function readJson(response: Response, url: string): Promise<unknown> {
  try {
    return await response.json();
  } catch (cause) {
    throw new PostgrestAdapterError({
      message: `PostgrestDataAdapter: failed to parse JSON response from ${url}: ${(cause as Error).message}`,
      status: response.status,
      url,
      responseBody: null,
      code: 'parse',
    });
  }
}

async function assertOk(response: Response, url: string): Promise<void> {
  if (response.ok) return;
  let body: string | null = null;
  try {
    body = await response.text();
  } catch {
    body = null;
  }
  throw new PostgrestAdapterError({
    message: `PostgrestDataAdapter: request to ${url} failed with status ${response.status}`,
    status: response.status,
    url,
    responseBody: body,
    code: 'http',
  });
}

function adapterConfigError(message: string): PostgrestAdapterError {
  return new PostgrestAdapterError({
    message,
    status: 0,
    url: '',
    responseBody: null,
    code: 'config',
  });
}
