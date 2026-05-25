import { describe, expect, it } from 'vitest';

import {
  PostgrestAdapterError,
  PostgrestDataAdapter,
} from '../../src/lib/adapter/index.js';
import type { FetchLike } from '../../src/lib/adapter/index.js';

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
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
    });
    return Promise.resolve(factory());
  };
  return { calls, fetch };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('PostgrestDataAdapter.get', () => {
  it('targets the default `id` primary key with `eq.<id>` and limit=1', async () => {
    const { calls, fetch } = makeFetch(() =>
      jsonResponse({ id: 7, title: 'A Book' }),
    );
    const adapter = new PostgrestDataAdapter({
      baseUrl: 'http://api.example',
      fetch,
    });

    const row = await adapter.get('books', 7);

    expect(calls[0].url).toBe('http://api.example/books?id=eq.7&limit=1');
    expect(calls[0].headers.Accept).toBe('application/vnd.pgrst.object+json');
    expect(row).toEqual({ id: 7, title: 'A Book' });
  });

  it('respects a string `primaryKey` option for every resource', async () => {
    const { calls, fetch } = makeFetch(() =>
      jsonResponse({ slug: 'a-book', title: 'A Book' }),
    );
    const adapter = new PostgrestDataAdapter({
      baseUrl: 'http://api.example',
      fetch,
      primaryKey: 'slug',
    });

    await adapter.get('books', 'a-book');

    expect(calls[0].url).toBe(
      'http://api.example/books?slug=eq.a-book&limit=1',
    );
  });

  it('respects a function `primaryKey` option that varies per resource', async () => {
    const { calls, fetch } = makeFetch(() =>
      jsonResponse({ uuid: 'abc-123' }),
    );
    const adapter = new PostgrestDataAdapter({
      baseUrl: 'http://api.example',
      fetch,
      primaryKey: (resource) =>
        resource === 'profiles' ? 'uuid' : 'id',
    });

    await adapter.get('profiles', 'abc-123');

    expect(calls[0].url).toBe(
      'http://api.example/profiles?uuid=eq.abc-123&limit=1',
    );
  });

  it('throws a PostgrestAdapterError when the server responds with 404', async () => {
    const { fetch } = makeFetch(() => jsonResponse({ message: 'not found' }, 404));
    const adapter = new PostgrestDataAdapter({
      baseUrl: 'http://api.example',
      fetch,
    });

    await expect(adapter.get('books', 999)).rejects.toBeInstanceOf(
      PostgrestAdapterError,
    );
    await expect(adapter.get('books', 999)).rejects.toMatchObject({
      status: 404,
      code: 'http',
    });
  });

  it('adds Accept-Profile header when the resource targets a non-default schema', async () => {
    const { calls, fetch } = makeFetch(() =>
      jsonResponse({ id: 1, kind: 'login' }),
    );
    const adapter = new PostgrestDataAdapter({
      baseUrl: 'http://api.example',
      fetch,
    });

    await adapter.get('audit.events', 1);

    expect(calls[0].headers['Accept-Profile']).toBe('audit');
    expect(calls[0].url).toBe('http://api.example/events?id=eq.1&limit=1');
  });
});
