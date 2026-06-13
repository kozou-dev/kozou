import { describe, expect, it } from 'vitest';

import { KozouApiAdapterError, KozouApiDataAdapter } from '../../src/lib/adapter/index.js';
import type { FetchLike } from '../../src/lib/adapter/index.js';

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function makeFetch(factory: () => Response): { calls: FetchCall[]; fetch: FetchLike } {
  const calls: FetchCall[] = [];
  const fetch: FetchLike = (url, init) => {
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: { ...(init?.headers ?? {}) },
      body: init?.body,
    });
    return Promise.resolve(factory());
  };
  return { calls, fetch };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
  });
}

function adapterWith(factory: () => Response): {
  calls: FetchCall[];
  adapter: KozouApiDataAdapter;
} {
  const { calls, fetch } = makeFetch(factory);
  return { calls, adapter: new KozouApiDataAdapter({ baseUrl: 'http://api.example/', fetch }) };
}

describe('KozouApiDataAdapter constructor', () => {
  it('requires a baseUrl', () => {
    expect(() => new KozouApiDataAdapter({ baseUrl: '', fetch: () => Promise.resolve(jsonResponse({})) })).toThrow(
      /baseUrl/,
    );
  });
});

describe('KozouApiDataAdapter.list', () => {
  it('sends page/pageSize defaults and maps the JSON envelope', async () => {
    const { calls, adapter } = adapterWith(() =>
      jsonResponse({ rows: [{ id: 1 }, { id: 2 }], total: 7, page: 1, pageSize: 50 }),
    );
    const result = await adapter.list('books', {});

    expect(calls[0].method).toBe('GET');
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe('/books');
    expect(url.searchParams.get('page')).toBe('1');
    expect(url.searchParams.get('pageSize')).toBe('50');
    expect(result).toEqual({ rows: [{ id: 1 }, { id: 2 }], total: 7, page: 1, pageSize: 50 });
  });

  it('encodes sort, search, and column filters; drops the __or search sentinel', async () => {
    const { calls, adapter } = adapterWith(() => jsonResponse({ rows: [], total: 0, page: 2, pageSize: 20 }));
    await adapter.list('books', {
      page: 2,
      pageSize: 20,
      sort: [
        { field: 'title', order: 'asc' },
        { field: 'created_at', order: 'desc' },
      ],
      search: 'svelte',
      filters: { __or: 'title.ilike.*svelte*', status: 'published' },
    });

    const url = new URL(calls[0].url);
    expect(url.searchParams.get('sort')).toBe('title.asc,created_at.desc');
    expect(url.searchParams.get('search')).toBe('svelte');
    expect(url.searchParams.get('status')).toBe('published');
    expect(url.searchParams.get('__or')).toBeNull();
  });

  it('targets a schema-qualified resource as a single path segment', async () => {
    const { calls, adapter } = adapterWith(() => jsonResponse({ rows: [], total: 0, page: 1, pageSize: 50 }));
    await adapter.list('audit.events', {});
    expect(new URL(calls[0].url).pathname).toBe('/audit.events');
  });
});

describe('KozouApiDataAdapter.get', () => {
  it('GETs the item path and returns the row', async () => {
    const { calls, adapter } = adapterWith(() => jsonResponse({ id: 'abc', title: 'X' }));
    const row = await adapter.get('books', 'abc');
    expect(calls[0].method).toBe('GET');
    expect(new URL(calls[0].url).pathname).toBe('/books/abc');
    expect(row).toEqual({ id: 'abc', title: 'X' });
  });

  it('throws a KozouApiAdapterError on a 404', async () => {
    const { adapter } = adapterWith(() => jsonResponse({ error: { code: 'not_found' } }, 404));
    await expect(adapter.get('books', 'missing')).rejects.toBeInstanceOf(KozouApiAdapterError);
  });

  it('builds a composite item path by comma-joining encoded components', async () => {
    const { calls, adapter } = adapterWith(() =>
      jsonResponse({ order_id: 100, line_no: 2, qty: 5 }),
    );
    await adapter.get('order_lines', [100, 2]);
    // The separator comma is left unescaped; only each component is encoded.
    expect(new URL(calls[0].url).pathname).toBe('/order_lines/100,2');
  });

  it('percent-encodes each composite component but not the separator', async () => {
    const { calls, adapter } = adapterWith(() => jsonResponse({}));
    await adapter.get('order_lines', ['a/b', 'c d']);
    expect(new URL(calls[0].url).pathname).toBe('/order_lines/a%2Fb,c%20d');
  });
});

describe('KozouApiDataAdapter mutations', () => {
  it('POSTs a JSON body for create', async () => {
    const { calls, adapter } = adapterWith(() => jsonResponse({ id: 'new', title: 'X' }, 201));
    const row = await adapter.create('books', { title: 'X' });
    expect(calls[0].method).toBe('POST');
    expect(new URL(calls[0].url).pathname).toBe('/books');
    expect(calls[0].headers['Content-Type']).toBe('application/json');
    expect(calls[0].body).toBe(JSON.stringify({ title: 'X' }));
    expect(row).toEqual({ id: 'new', title: 'X' });
  });

  it('PATCHes the item path for update', async () => {
    const { calls, adapter } = adapterWith(() => jsonResponse({ id: 'abc', title: 'Y' }));
    await adapter.update('books', 'abc', { title: 'Y' });
    expect(calls[0].method).toBe('PATCH');
    expect(new URL(calls[0].url).pathname).toBe('/books/abc');
    expect(calls[0].body).toBe(JSON.stringify({ title: 'Y' }));
  });

  it('DELETEs the item path', async () => {
    const { calls, adapter } = adapterWith(() => jsonResponse({ id: 'abc' }));
    await adapter.delete('books', 'abc');
    expect(calls[0].method).toBe('DELETE');
    expect(new URL(calls[0].url).pathname).toBe('/books/abc');
  });

  it('PATCHes and DELETEs a composite item path', async () => {
    const { calls, adapter } = adapterWith(() => jsonResponse({ order_id: 100, line_no: 2 }));
    await adapter.update('order_lines', [100, 2], { qty: 9 });
    expect(calls[0].method).toBe('PATCH');
    expect(new URL(calls[0].url).pathname).toBe('/order_lines/100,2');

    await adapter.delete('order_lines', [100, 2]);
    expect(calls[1].method).toBe('DELETE');
    expect(new URL(calls[1].url).pathname).toBe('/order_lines/100,2');
  });

  it('surfaces a non-2xx mutation as a KozouApiAdapterError', async () => {
    const { adapter } = adapterWith(() => jsonResponse({ error: { code: 'bad_request' } }, 400));
    await expect(adapter.create('books', { bogus: 1 })).rejects.toMatchObject({
      name: 'KozouApiAdapterError',
      status: 400,
    });
  });
});

describe('KozouApiDataAdapter.searchRelation', () => {
  it('queries the options mode and returns the option list', async () => {
    const { calls, adapter } = adapterWith(() =>
      jsonResponse({ options: [{ id: 1, label: 'Ada' }] }),
    );
    const options = await adapter.searchRelation('authors', {
      query: 'ad',
      labelField: 'display_name',
      searchFields: ['display_name', 'email'],
      limit: 5,
    });

    const url = new URL(calls[0].url);
    expect(url.pathname).toBe('/authors');
    expect(url.searchParams.get('as')).toBe('options');
    expect(url.searchParams.get('label')).toBe('display_name');
    expect(url.searchParams.get('fields')).toBe('display_name,email');
    expect(url.searchParams.get('q')).toBe('ad');
    expect(url.searchParams.get('limit')).toBe('5');
    expect(options).toEqual([{ id: 1, label: 'Ada' }]);
  });
});

describe('KozouApiDataAdapter.callFunction', () => {
  it('POSTs the named-args body to /rpc/<schema>.<fn> and returns the result', async () => {
    const { calls, adapter } = adapterWith(() => jsonResponse(42));
    const result = await adapter.callFunction('public.add_two', { a: 40, b: 2 });
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe('http://api.example/rpc/public.add_two');
    expect(JSON.parse(calls[0].body ?? '{}')).toEqual({ a: 40, b: 2 });
    expect(calls[0].headers['Content-Type']).toBe('application/json');
    expect(result).toBe(42);
  });

  it('returns null for a 204 (void) response without parsing a body', async () => {
    const { adapter } = adapterWith(() => new Response(null, { status: 204 }));
    expect(await adapter.callFunction('public.noop', {})).toBeNull();
  });

  it('throws a KozouApiAdapterError carrying the status on a non-ok response', async () => {
    const { adapter } = adapterWith(() =>
      jsonResponse({ error: { code: 'forbidden', message: 'Permission denied.' } }, 403),
    );
    await expect(adapter.callFunction('public.secret_op', {})).rejects.toMatchObject({
      name: 'KozouApiAdapterError',
      status: 403,
    });
  });
});
