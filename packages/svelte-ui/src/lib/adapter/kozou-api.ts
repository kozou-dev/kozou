// KozouApiDataAdapter — DataAdapter implementation that speaks the
// in-house @kozou/api REST wire format (Kozou v0.2 spec §2-§4). It is a
// sibling of the other adapter in this directory; getAdapter() selects it
// when the operator opts into the in-house API layer
// (KOZOU_ADAPTER_KIND=api). Like its sibling it ships no server code, only
// an HTTP client for the API surface.
//
// Wire format (see @kozou/api):
//   GET    /<resource>?page=&pageSize=&sort=f.asc,g.desc&search=&<col>=<v>
//   GET    /<resource>/<id>
//   POST   /<resource>                 (JSON body)
//   PATCH  /<resource>/<id>            (JSON body)
//   DELETE /<resource>/<id>
//   GET    /<resource>?as=options&label=&fields=&q=&limit=

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
const DEFAULT_RELATION_LIMIT = 20;

// The UI encodes free-text search as a `filters.__or` sentinel for the
// other adapter; the in-house API does free-text search through its own
// `search=` parameter, so this key is dropped from column filters here.
const OR_FILTER_KEY = '__or';

export interface KozouApiAdapterOptions {
  /** Base URL of the @kozou/api server (trailing slash is stripped). */
  baseUrl: string;
  /** Static headers merged into every request (e.g. Authorization). */
  headers?: Record<string, string>;
  /** Fetch override; defaults to `globalThis.fetch`. Injection point for tests. */
  fetch?: FetchLike;
  /** Page size used when ListParams.pageSize is omitted. */
  defaultPageSize?: number;
}

export class KozouApiAdapterError extends AdapterError {
  constructor(init: AdapterErrorInit) {
    super(init);
    this.name = 'KozouApiAdapterError';
  }
}

export class KozouApiDataAdapter implements DataAdapter {
  private readonly baseUrl: string;
  private readonly staticHeaders: Record<string, string>;
  private readonly fetchImpl: FetchLike;
  private readonly defaultPageSize: number;

  constructor(opts: KozouApiAdapterOptions) {
    if (typeof opts.baseUrl !== 'string' || opts.baseUrl.length === 0) {
      throw configError('KozouApiDataAdapter: `baseUrl` is required.');
    }
    this.baseUrl = stripTrailingSlash(opts.baseUrl);
    this.staticHeaders = { ...(opts.headers ?? {}) };
    this.defaultPageSize = opts.defaultPageSize ?? DEFAULT_PAGE_SIZE;

    const resolvedFetch = opts.fetch ?? (globalThis.fetch as FetchLike | undefined);
    if (typeof resolvedFetch !== 'function') {
      throw configError(
        'KozouApiDataAdapter: a `fetch` implementation is required (none injected, none on globalThis).',
      );
    }
    this.fetchImpl = resolvedFetch;
  }

  async list(resource: string, params: ListParams): Promise<ListResult> {
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? this.defaultPageSize;

    const query = new URLSearchParams();
    query.set('page', String(page));
    query.set('pageSize', String(pageSize));
    appendSort(query, params.sort);
    if (params.search !== undefined && params.search.length > 0) {
      query.set('search', params.search);
    }
    appendFilters(query, params.filters);

    const url = `${this.baseUrl}/${encodeResource(resource)}?${query.toString()}`;
    const body = (await this.getJson(url)) as Partial<ListResult>;
    return {
      rows: Array.isArray(body.rows) ? body.rows : [],
      total: typeof body.total === 'number' ? body.total : (body.rows?.length ?? 0),
      page: typeof body.page === 'number' ? body.page : page,
      pageSize: typeof body.pageSize === 'number' ? body.pageSize : pageSize,
    };
  }

  async get(resource: string, id: ResourceId): Promise<Record<string, unknown>> {
    const url = this.itemUrl(resource, id);
    return (await this.getJson(url)) as Record<string, unknown>;
  }

  async create(
    resource: string,
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const url = `${this.baseUrl}/${encodeResource(resource)}`;
    return (await this.sendJson('POST', url, data)) as Record<string, unknown>;
  }

  async update(
    resource: string,
    id: ResourceId,
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return (await this.sendJson('PATCH', this.itemUrl(resource, id), data)) as Record<
      string,
      unknown
    >;
  }

  async delete(resource: string, id: ResourceId): Promise<void> {
    const url = this.itemUrl(resource, id);
    const headers = { ...this.staticHeaders, Accept: 'application/json' };
    const response = await this.send('DELETE', url, headers, undefined);
    await assertOk(response, url);
  }

  async searchRelation(
    resource: string,
    params: SearchRelationParams,
  ): Promise<RelationOption[]> {
    const query = new URLSearchParams();
    query.set('as', 'options');
    query.set('label', params.labelField);
    if (params.searchFields.length > 0) {
      query.set('fields', params.searchFields.join(','));
    }
    if (params.query.length > 0) query.set('q', params.query);
    query.set('limit', String(params.limit ?? DEFAULT_RELATION_LIMIT));

    const url = `${this.baseUrl}/${encodeResource(resource)}?${query.toString()}`;
    const body = (await this.getJson(url)) as { options?: RelationOption[] };
    return Array.isArray(body.options) ? body.options : [];
  }

  // Item path: `/<resource>/<id>`. A composite key encodes each component
  // and joins them with an unescaped comma (Kozou v0.2/v1.0 wire format,
  // §3.2); the server decodes the segment, then splits on commas. A scalar
  // key is encoded verbatim, so single-column keys are unchanged.
  private itemUrl(resource: string, id: ResourceId): string {
    const segment = Array.isArray(id)
      ? id.map((part) => encodeURIComponent(String(part))).join(',')
      : encodeURIComponent(String(id));
    return `${this.baseUrl}/${encodeResource(resource)}/${segment}`;
  }

  private async getJson(url: string): Promise<unknown> {
    const headers = { ...this.staticHeaders, Accept: 'application/json' };
    const response = await this.send('GET', url, headers, undefined);
    await assertOk(response, url);
    return readJson(response, url);
  }

  private async sendJson(
    method: 'POST' | 'PATCH',
    url: string,
    data: Record<string, unknown>,
  ): Promise<unknown> {
    const headers = {
      ...this.staticHeaders,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
    const response = await this.send(method, url, headers, JSON.stringify(data));
    await assertOk(response, url);
    return readJson(response, url);
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
      throw new KozouApiAdapterError({
        message: `KozouApiDataAdapter: ${method} ${url} failed before reaching the server: ${(cause as Error).message}`,
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

function encodeResource(resource: string): string {
  return encodeURIComponent(resource);
}

function appendSort(query: URLSearchParams, sort: SortSpec[] | undefined): void {
  if (!sort || sort.length === 0) return;
  query.set('sort', sort.map((s) => `${s.field}.${s.order}`).join(','));
}

function appendFilters(
  query: URLSearchParams,
  filters: Record<string, unknown> | undefined,
): void {
  if (!filters) return;
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || key === OR_FILTER_KEY) continue;
    query.set(key, String(value));
  }
}

async function readJson(response: Response, url: string): Promise<unknown> {
  try {
    return await response.json();
  } catch (cause) {
    throw new KozouApiAdapterError({
      message: `KozouApiDataAdapter: failed to parse JSON response from ${url}: ${(cause as Error).message}`,
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
  throw new KozouApiAdapterError({
    message: `KozouApiDataAdapter: request to ${url} failed with status ${response.status}`,
    status: response.status,
    url,
    responseBody: body,
    code: 'http',
  });
}

function configError(message: string): KozouApiAdapterError {
  return new KozouApiAdapterError({
    message,
    status: 0,
    url: '',
    responseBody: null,
    code: 'config',
  });
}
