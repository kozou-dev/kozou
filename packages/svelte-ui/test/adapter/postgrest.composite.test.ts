import { describe, expect, it } from 'vitest';

import { PostgrestDataAdapter } from '../../src/lib/adapter/index.js';
import type { FetchLike } from '../../src/lib/adapter/index.js';

interface FetchCall {
  url: string;
  method: string;
  body: string | undefined;
}

function makeFetch(
  factory: () => Response,
): { calls: FetchCall[]; fetch: FetchLike } {
  const calls: FetchCall[] = [];
  const fetch: FetchLike = (url, init) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body });
    return Promise.resolve(factory());
  };
  return { calls, fetch };
}

function jsonResponse(
  body: unknown,
  init: { status?: number; contentRange?: string } = {},
): Response {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (init.contentRange !== undefined) {
    headers.set('content-range', init.contentRange);
  }
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers });
}

// A two-column key resolver: `order_lines` is composite, everything else
// keeps the default single `id`.
const compositePk = (resource: string): string | string[] =>
  resource === 'order_lines' ? ['order_id', 'line_no'] : 'id';

describe('PostgrestDataAdapter composite primary keys', () => {
  it('get expands a composite id into per-column eq filters in key order', async () => {
    const { calls, fetch } = makeFetch(() =>
      jsonResponse({ order_id: 100, line_no: 2, qty: 5 }),
    );
    const adapter = new PostgrestDataAdapter({
      baseUrl: 'http://api.example',
      fetch,
      primaryKey: compositePk,
    });

    await adapter.get('order_lines', [100, 2]);

    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toBe(
      'http://api.example/order_lines?order_id=eq.100&line_no=eq.2&limit=1',
    );
  });

  it('update targets all key columns', async () => {
    const { calls, fetch } = makeFetch(() =>
      jsonResponse({ order_id: 100, line_no: 2, qty: 9 }),
    );
    const adapter = new PostgrestDataAdapter({
      baseUrl: 'http://api.example',
      fetch,
      primaryKey: compositePk,
    });

    await adapter.update('order_lines', [100, 2], { qty: 9 });

    expect(calls[0].method).toBe('PATCH');
    expect(calls[0].url).toBe(
      'http://api.example/order_lines?order_id=eq.100&line_no=eq.2',
    );
    expect(calls[0].body).toBe(JSON.stringify({ qty: 9 }));
  });

  it('delete targets all key columns', async () => {
    const { calls, fetch } = makeFetch(() => new Response(null, { status: 204 }));
    const adapter = new PostgrestDataAdapter({
      baseUrl: 'http://api.example',
      fetch,
      primaryKey: compositePk,
    });

    await adapter.delete('order_lines', [100, 2]);

    expect(calls[0].method).toBe('DELETE');
    expect(calls[0].url).toBe(
      'http://api.example/order_lines?order_id=eq.100&line_no=eq.2',
    );
  });

  it('still handles a single-column key passed as a scalar', async () => {
    const { calls, fetch } = makeFetch(() => jsonResponse({ id: 7 }));
    const adapter = new PostgrestDataAdapter({
      baseUrl: 'http://api.example',
      fetch,
      primaryKey: compositePk,
    });

    await adapter.get('books', 7);

    expect(calls[0].url).toBe('http://api.example/books?id=eq.7&limit=1');
  });

  it('throws when the id arity does not match the key arity', async () => {
    const { fetch } = makeFetch(() => jsonResponse({}));
    const adapter = new PostgrestDataAdapter({
      baseUrl: 'http://api.example',
      fetch,
      primaryKey: compositePk,
    });

    await expect(adapter.get('order_lines', 100)).rejects.toMatchObject({
      code: 'config',
    });
  });

  it('searchRelation selects every key column and returns array ids', async () => {
    const { calls, fetch } = makeFetch(() =>
      jsonResponse([{ order_id: 100, line_no: 2, note: 'second line' }]),
    );
    const adapter = new PostgrestDataAdapter({
      baseUrl: 'http://api.example',
      fetch,
      primaryKey: compositePk,
    });

    const options = await adapter.searchRelation('order_lines', {
      query: '',
      labelField: 'note',
      searchFields: ['note'],
    });

    const url = new URL(calls[0].url);
    expect(url.searchParams.get('select')).toBe('order_id,line_no,note');
    // The id components follow key declaration order — a valid item id.
    expect(options).toEqual([{ id: [100, 2], label: 'second line' }]);
  });

  it('searchRelation does not select the label twice when it is a key column', async () => {
    const { calls, fetch } = makeFetch(() =>
      jsonResponse([{ order_id: 100, line_no: 2 }]),
    );
    const adapter = new PostgrestDataAdapter({
      baseUrl: 'http://api.example',
      fetch,
      primaryKey: compositePk,
    });

    const options = await adapter.searchRelation('order_lines', {
      query: '',
      labelField: 'line_no',
      searchFields: [],
    });

    expect(new URL(calls[0].url).searchParams.get('select')).toBe('order_id,line_no');
    expect(options).toEqual([{ id: [100, 2], label: '2' }]);
  });

  it('rejects a primaryKey resolver that returns no key columns', async () => {
    const { fetch } = makeFetch(() => jsonResponse([]));
    const adapter = new PostgrestDataAdapter({
      baseUrl: 'http://api.example',
      fetch,
      primaryKey: () => [],
    });

    // A key-less resource must fail loudly everywhere a key is required —
    // a zero-column key would otherwise emit empty option ids from
    // searchRelation and unfiltered mutations from update / delete.
    await expect(
      adapter.searchRelation('event_log', { query: '', labelField: 'payload', searchFields: [] }),
    ).rejects.toMatchObject({ code: 'config' });
    await expect(adapter.get('event_log', [])).rejects.toMatchObject({ code: 'config' });
    await expect(adapter.delete('event_log', [])).rejects.toMatchObject({ code: 'config' });
  });
});

describe('PostgrestDataAdapter filter operators', () => {
  it('forwards an operator-prefixed value verbatim, defaults a bare value to eq', async () => {
    const { calls, fetch } = makeFetch(() =>
      jsonResponse([], { contentRange: '0-0/0' }),
    );
    const adapter = new PostgrestDataAdapter({ baseUrl: 'http://api.example', fetch });

    await adapter.list('order_lines', {
      filters: { qty: 'gt.4', line_no: 'in.(1,2)', product: 'is.null', order_id: 100 },
    });

    const url = new URL(calls[0].url);
    expect(url.searchParams.get('qty')).toBe('gt.4');
    expect(url.searchParams.get('line_no')).toBe('in.(1,2)');
    expect(url.searchParams.get('product')).toBe('is.null');
    // No operator prefix -> equality, the legacy form.
    expect(url.searchParams.get('order_id')).toBe('eq.100');
  });

  it('treats an unknown prefix as a literal equality value', async () => {
    const { calls, fetch } = makeFetch(() =>
      jsonResponse([], { contentRange: '0-0/0' }),
    );
    const adapter = new PostgrestDataAdapter({ baseUrl: 'http://api.example', fetch });

    await adapter.list('books', { filters: { title: 'foo.bar' } });

    expect(new URL(calls[0].url).searchParams.get('title')).toBe('eq.foo.bar');
  });

  it('escapes an operator-like literal value via an explicit eq. prefix', async () => {
    const { calls, fetch } = makeFetch(() =>
      jsonResponse([], { contentRange: '0-0/0' }),
    );
    const adapter = new PostgrestDataAdapter({ baseUrl: 'http://api.example', fetch });

    // To match the literal string "is.null" (not apply the IS NULL operator),
    // the caller escapes it with a leading `eq.`. The value is forwarded
    // verbatim — the same escape the in-house API and the REST surface use.
    await adapter.list('books', { filters: { status: 'eq.is.null' } });

    expect(new URL(calls[0].url).searchParams.get('status')).toBe('eq.is.null');
  });
});
