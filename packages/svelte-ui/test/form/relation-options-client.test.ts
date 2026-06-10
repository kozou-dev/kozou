import { describe, expect, it, vi } from 'vitest';

import {
  fetchRelationOptions,
  RELATION_OPTIONS_PATH,
  relationOptionsUrl,
} from '../../src/lib/form/relation-options-client.js';

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    json: async () => body,
  } as unknown as Response;
}

describe('relationOptionsUrl', () => {
  it('encodes resource + label and omits empty search / query / limit', () => {
    const url = relationOptionsUrl('public.authors', {
      query: '',
      labelField: 'display_name',
      searchFields: [],
    });
    const params = new URL(url, 'http://x').searchParams;
    expect(url.startsWith(`${RELATION_OPTIONS_PATH}?`)).toBe(true);
    expect(params.get('resource')).toBe('public.authors');
    expect(params.get('label')).toBe('display_name');
    expect(params.get('fields')).toBeNull();
    expect(params.get('q')).toBeNull();
    expect(params.get('limit')).toBeNull();
  });

  it('includes fields, q and limit when present', () => {
    const url = relationOptionsUrl('public.authors', {
      query: 'atw',
      labelField: 'display_name',
      searchFields: ['display_name', 'pen_name'],
      limit: 5,
    });
    const params = new URL(url, 'http://x').searchParams;
    expect(params.get('fields')).toBe('display_name,pen_name');
    expect(params.get('q')).toBe('atw');
    expect(params.get('limit')).toBe('5');
  });
});

describe('fetchRelationOptions', () => {
  it('returns the parsed options on a 2xx response', async () => {
    const options = [
      { id: 'a1', label: 'Margaret Atwood' },
      { id: 'a2', label: 'Ursula K. Le Guin' },
    ];
    const fetchFn = vi.fn(async (_url: string) => jsonResponse({ options }));

    const result = await fetchRelationOptions(fetchFn, 'public.authors', {
      query: '',
      labelField: 'display_name',
      searchFields: ['display_name'],
    });

    expect(result).toEqual(options);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [calledUrl] = fetchFn.mock.calls[0];
    expect(calledUrl).toContain('resource=public.authors');
    expect(calledUrl).toContain('label=display_name');
  });

  it('degrades to an empty list on a non-2xx response without reading the body', async () => {
    const json = vi.fn();
    const fetchFn = vi.fn(
      async () => ({ ok: false, json } as unknown as Response),
    );

    const result = await fetchRelationOptions(fetchFn, 'public.authors', {
      query: 'x',
      labelField: 'display_name',
      searchFields: ['display_name'],
    });

    expect(result).toEqual([]);
    expect(json).not.toHaveBeenCalled();
  });

  it('degrades to an empty list when the body has no options array', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({}));
    const result = await fetchRelationOptions(fetchFn, 'public.authors', {
      query: '',
      labelField: 'display_name',
      searchFields: [],
    });
    expect(result).toEqual([]);
  });
});
