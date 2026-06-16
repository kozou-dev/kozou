import { describe, expect, it } from 'vitest';

import { PostgrestDataAdapter } from '../../src/adapter/index.js';
import type { FetchLike } from '../../src/adapter/index.js';

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

describe('PostgrestDataAdapter.searchRelation', () => {
  it('builds select=<pk>,<labelField> + or=(<searchFields>.ilike.*q*) + limit', async () => {
    const { calls, fetch } = makeFetch(() => jsonResponse([]));
    const adapter = new PostgrestDataAdapter({
      baseUrl: 'http://api.example',
      fetch,
    });

    await adapter.searchRelation('authors', {
      query: 'aus',
      labelField: 'name',
      searchFields: ['name', 'pen_name'],
      limit: 10,
    });

    const url = new URL(calls[0].url);
    expect(url.pathname).toBe('/authors');
    expect(url.searchParams.get('select')).toBe('id,name');
    expect(url.searchParams.get('or')).toBe(
      '(name.ilike."*aus*",pen_name.ilike."*aus*")',
    );
    expect(url.searchParams.get('limit')).toBe('10');
  });

  it('double-quotes a search term with reserved characters', async () => {
    const { calls, fetch } = makeFetch(() => jsonResponse([]));
    const adapter = new PostgrestDataAdapter({
      baseUrl: 'http://api.example',
      fetch,
    });

    await adapter.searchRelation('authors', {
      query: 'Smith, John (Jr.)',
      labelField: 'name',
      searchFields: ['name'],
      limit: 10,
    });

    const url = new URL(calls[0].url);
    // The reserved characters (`,` `(` `)` `.`) sit inside the quoted value, so
    // they are matched literally instead of being read as or() structure.
    expect(url.searchParams.get('or')).toBe('(name.ilike."*Smith, John (Jr.)*")');
  });

  it('escapes embedded double quotes and backslashes in the search term', async () => {
    const { calls, fetch } = makeFetch(() => jsonResponse([]));
    const adapter = new PostgrestDataAdapter({
      baseUrl: 'http://api.example',
      fetch,
    });

    await adapter.searchRelation('authors', {
      query: 'a"b\\c',
      labelField: 'name',
      searchFields: ['name'],
      limit: 10,
    });

    const url = new URL(calls[0].url);
    // `\` -> `\\` and `"` -> `\"` inside the quoted value.
    expect(url.searchParams.get('or')).toBe('(name.ilike."*a\\"b\\\\c*")');
  });

  it('omits the or=() filter when the query string is empty', async () => {
    const { calls, fetch } = makeFetch(() => jsonResponse([]));
    const adapter = new PostgrestDataAdapter({
      baseUrl: 'http://api.example',
      fetch,
    });

    await adapter.searchRelation('authors', {
      query: '',
      labelField: 'name',
      searchFields: ['name'],
    });

    const url = new URL(calls[0].url);
    expect(url.searchParams.get('or')).toBeNull();
    expect(url.searchParams.get('select')).toBe('id,name');
  });

  it('falls back to a limit of 20 when SearchRelationParams.limit is omitted', async () => {
    const { calls, fetch } = makeFetch(() => jsonResponse([]));
    const adapter = new PostgrestDataAdapter({
      baseUrl: 'http://api.example',
      fetch,
    });

    await adapter.searchRelation('authors', {
      query: 'a',
      labelField: 'name',
      searchFields: ['name'],
    });

    const url = new URL(calls[0].url);
    expect(url.searchParams.get('limit')).toBe('20');
  });

  it('maps response rows into { id, label } using the configured primaryKey + labelField', async () => {
    const { fetch } = makeFetch(() =>
      jsonResponse([
        { uuid: 'a-1', display_name: 'Alice' },
        { uuid: 'a-2', display_name: 'Aurora' },
      ]),
    );
    const adapter = new PostgrestDataAdapter({
      baseUrl: 'http://api.example',
      fetch,
      primaryKey: 'uuid',
    });

    const options = await adapter.searchRelation('authors', {
      query: 'a',
      labelField: 'display_name',
      searchFields: ['display_name'],
    });

    expect(options).toEqual([
      { id: 'a-1', label: 'Alice' },
      { id: 'a-2', label: 'Aurora' },
    ]);
  });

  it('adds Accept-Profile header when searching a non-default schema', async () => {
    const { calls, fetch } = makeFetch(() => jsonResponse([]));
    const adapter = new PostgrestDataAdapter({
      baseUrl: 'http://api.example',
      fetch,
    });

    await adapter.searchRelation('audit.actors', {
      query: 'sys',
      labelField: 'name',
      searchFields: ['name'],
    });

    expect(calls[0].headers['Accept-Profile']).toBe('audit');
    expect(new URL(calls[0].url).pathname).toBe('/actors');
  });
});
