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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function emptyResponse(status = 204): Response {
  return new Response(null, { status });
}

describe('PostgrestDataAdapter.create', () => {
  it('POSTs JSON to the table URL with return=representation + object Accept', async () => {
    const { calls, fetch } = makeFetch(() =>
      jsonResponse({ id: 1, title: 'New' }),
    );
    const adapter = new PostgrestDataAdapter({
      baseUrl: 'http://api.example',
      fetch,
    });

    const created = await adapter.create('books', { title: 'New' });

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.method).toBe('POST');
    expect(call.url).toBe('http://api.example/books');
    expect(call.headers['Content-Type']).toBe('application/json');
    expect(call.headers.Prefer).toBe('return=representation');
    expect(call.headers.Accept).toBe('application/vnd.pgrst.object+json');
    expect(call.body).toBe(JSON.stringify({ title: 'New' }));
    expect(created).toEqual({ id: 1, title: 'New' });
  });

  it('adds Content-Profile header when creating into a non-default schema', async () => {
    const { calls, fetch } = makeFetch(() => jsonResponse({ id: 1 }));
    const adapter = new PostgrestDataAdapter({
      baseUrl: 'http://api.example',
      fetch,
    });

    await adapter.create('audit.events', { kind: 'login' });

    expect(calls[0].url).toBe('http://api.example/events');
    expect(calls[0].headers['Content-Profile']).toBe('audit');
    expect(calls[0].headers['Accept-Profile']).toBeUndefined();
  });

  it('throws PostgrestAdapterError when the server responds with 400', async () => {
    const { fetch } = makeFetch(() =>
      jsonResponse({ message: 'check_violation' }, 400),
    );
    const adapter = new PostgrestDataAdapter({
      baseUrl: 'http://api.example',
      fetch,
    });

    await expect(
      adapter.create('books', { title: '' }),
    ).rejects.toBeInstanceOf(PostgrestAdapterError);
    await expect(
      adapter.create('books', { title: '' }),
    ).rejects.toMatchObject({ status: 400, code: 'http' });
  });
});

describe('PostgrestDataAdapter.update', () => {
  it('PATCHes ?id=eq.<id> with JSON body and representation Prefer', async () => {
    const { calls, fetch } = makeFetch(() =>
      jsonResponse({ id: 7, title: 'Updated' }),
    );
    const adapter = new PostgrestDataAdapter({
      baseUrl: 'http://api.example',
      fetch,
    });

    const updated = await adapter.update('books', 7, { title: 'Updated' });

    const [call] = calls;
    expect(call.method).toBe('PATCH');
    expect(call.url).toBe('http://api.example/books?id=eq.7');
    expect(call.headers['Content-Type']).toBe('application/json');
    expect(call.headers.Prefer).toBe('return=representation');
    expect(call.headers.Accept).toBe('application/vnd.pgrst.object+json');
    expect(call.body).toBe(JSON.stringify({ title: 'Updated' }));
    expect(updated).toEqual({ id: 7, title: 'Updated' });
  });

  it('respects a string primaryKey option', async () => {
    const { calls, fetch } = makeFetch(() => jsonResponse({ slug: 'a-book' }));
    const adapter = new PostgrestDataAdapter({
      baseUrl: 'http://api.example',
      fetch,
      primaryKey: 'slug',
    });

    await adapter.update('books', 'a-book', { title: 'Edited' });

    expect(calls[0].url).toBe('http://api.example/books?slug=eq.a-book');
  });

  it('respects a function primaryKey option that varies per resource', async () => {
    const { calls, fetch } = makeFetch(() => jsonResponse({ uuid: 'abc' }));
    const adapter = new PostgrestDataAdapter({
      baseUrl: 'http://api.example',
      fetch,
      primaryKey: (resource) => (resource === 'profiles' ? 'uuid' : 'id'),
    });

    await adapter.update('profiles', 'abc', { name: 'Alice' });

    expect(calls[0].url).toBe('http://api.example/profiles?uuid=eq.abc');
  });
});

describe('PostgrestDataAdapter.delete', () => {
  it('DELETEs ?id=eq.<id> and resolves to undefined when the server says 204', async () => {
    const { calls, fetch } = makeFetch(() => emptyResponse(204));
    const adapter = new PostgrestDataAdapter({
      baseUrl: 'http://api.example',
      fetch,
    });

    const result = await adapter.delete('books', 7);

    expect(result).toBeUndefined();
    const [call] = calls;
    expect(call.method).toBe('DELETE');
    expect(call.url).toBe('http://api.example/books?id=eq.7');
    expect(call.body).toBeUndefined();
    expect(call.headers['Content-Type']).toBeUndefined();
  });

  it('adds Content-Profile header when deleting from a non-default schema', async () => {
    const { calls, fetch } = makeFetch(() => emptyResponse(204));
    const adapter = new PostgrestDataAdapter({
      baseUrl: 'http://api.example',
      fetch,
    });

    await adapter.delete('audit.events', 1);

    expect(calls[0].url).toBe('http://api.example/events?id=eq.1');
    expect(calls[0].headers['Content-Profile']).toBe('audit');
  });

  it('throws PostgrestAdapterError when the server reports 409 on delete', async () => {
    const { fetch } = makeFetch(() =>
      jsonResponse({ message: 'foreign key constraint' }, 409),
    );
    const adapter = new PostgrestDataAdapter({
      baseUrl: 'http://api.example',
      fetch,
    });

    await expect(adapter.delete('books', 7)).rejects.toMatchObject({
      status: 409,
      code: 'http',
    });
  });
});
