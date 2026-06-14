import { describe, expect, it } from 'vitest';

import { PostgrestDataAdapter } from '../../src/adapter/index.js';
import type { FetchLike } from '../../src/adapter/index.js';

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function makeFetch(
  factory: () => Response,
): { calls: FetchCall[]; fetch: FetchLike } {
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

function jsonResponse(
  body: unknown,
  init: { status?: number; contentRange?: string } = {},
): Response {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (init.contentRange !== undefined) {
    headers.set('content-range', init.contentRange);
  }
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers,
  });
}

describe('PostgrestDataAdapter.list', () => {
  it('issues a GET with default page=1 / pageSize=50, count=exact and Accept: application/json', async () => {
    const { calls, fetch } = makeFetch(() =>
      jsonResponse([], { contentRange: '0-0/0' }),
    );
    const adapter = new PostgrestDataAdapter({
      baseUrl: 'http://api.example/',
      fetch,
    });

    await adapter.list('books', {});

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.method).toBe('GET');
    expect(call.url).toBe('http://api.example/books?limit=50&offset=0');
    expect(call.headers.Accept).toBe('application/json');
    expect(call.headers.Prefer).toBe('count=exact');
    expect(call.headers['Accept-Profile']).toBeUndefined();
  });

  it('translates the 1-based page / pageSize into limit + offset', async () => {
    const { calls, fetch } = makeFetch(() =>
      jsonResponse([], { contentRange: '40-59/123' }),
    );
    const adapter = new PostgrestDataAdapter({
      baseUrl: 'http://api.example',
      fetch,
    });

    await adapter.list('books', { page: 3, pageSize: 20 });

    expect(calls[0].url).toBe(
      'http://api.example/books?limit=20&offset=40',
    );
  });

  it('appends the sort spec as a comma-joined `order=` parameter', async () => {
    const { calls, fetch } = makeFetch(() =>
      jsonResponse([], { contentRange: '0-0/0' }),
    );
    const adapter = new PostgrestDataAdapter({
      baseUrl: 'http://api.example',
      fetch,
    });

    await adapter.list('books', {
      sort: [
        { field: 'title', order: 'asc' },
        { field: 'created_at', order: 'desc' },
      ],
    });

    const url = new URL(calls[0].url);
    expect(url.searchParams.get('order')).toBe('title.asc,created_at.desc');
  });

  it('serializes plain filters into PostgREST `col=eq.value` form', async () => {
    const { calls, fetch } = makeFetch(() =>
      jsonResponse([], { contentRange: '0-0/0' }),
    );
    const adapter = new PostgrestDataAdapter({
      baseUrl: 'http://api.example',
      fetch,
    });

    await adapter.list('books', {
      filters: { author_id: 42, status: 'published' },
    });

    const url = new URL(calls[0].url);
    expect(url.searchParams.get('author_id')).toBe('eq.42');
    expect(url.searchParams.get('status')).toBe('eq.published');
  });

  it('translates the convention `__or` filter key into `or=(...)`', async () => {
    const { calls, fetch } = makeFetch(() =>
      jsonResponse([], { contentRange: '0-0/0' }),
    );
    const adapter = new PostgrestDataAdapter({
      baseUrl: 'http://api.example',
      fetch,
    });

    await adapter.list('books', {
      filters: { __or: 'title.ilike.*svelte*,author.ilike.*svelte*' },
    });

    const url = new URL(calls[0].url);
    expect(url.searchParams.get('or')).toBe(
      '(title.ilike.*svelte*,author.ilike.*svelte*)',
    );
  });

  it('extracts `total` from the Content-Range response header', async () => {
    const { fetch } = makeFetch(() =>
      jsonResponse([{ id: 1 }, { id: 2 }], { contentRange: '0-1/123' }),
    );
    const adapter = new PostgrestDataAdapter({
      baseUrl: 'http://api.example',
      fetch,
    });

    const result = await adapter.list('books', {});

    expect(result.total).toBe(123);
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(50);
    expect(result.rows).toHaveLength(2);
  });

  it('falls back to rows.length when Content-Range reports `*` (count unknown)', async () => {
    const { fetch } = makeFetch(() =>
      jsonResponse([{ id: 1 }, { id: 2 }, { id: 3 }], { contentRange: '0-2/*' }),
    );
    const adapter = new PostgrestDataAdapter({
      baseUrl: 'http://api.example',
      fetch,
    });

    const result = await adapter.list('books', {});

    expect(result.total).toBe(3);
  });

  it('adds Accept-Profile header when the resource targets a non-default schema', async () => {
    const { calls, fetch } = makeFetch(() =>
      jsonResponse([], { contentRange: '0-0/0' }),
    );
    const adapter = new PostgrestDataAdapter({
      baseUrl: 'http://api.example',
      fetch,
    });

    await adapter.list('audit.events', {});

    expect(calls[0].headers['Accept-Profile']).toBe('audit');
    expect(calls[0].url).toBe('http://api.example/events?limit=50&offset=0');
  });
});
