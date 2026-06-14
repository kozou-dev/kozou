import { describe, expect, it } from 'vitest';

import { parseListParamsFromUrl } from '../../src/query/list-params.js';

describe('parseListParamsFromUrl', () => {
  it('falls back to page=1 / pageSize=50 and empty sort/search when no query params are set', () => {
    const result = parseListParamsFromUrl({
      url: new URL('http://app.example/tables/public.books'),
      searchFields: ['title', 'author'],
    });

    expect(result).toEqual({
      search: '',
      filters: {},
      sort: [],
      page: 1,
      pageSize: 50,
    });
  });

  it('expands ?q= into filters.__or using a comma-joined ilike expression of every searchField', () => {
    const result = parseListParamsFromUrl({
      url: new URL('http://app.example/tables/public.books?q=svelte'),
      searchFields: ['title', 'subtitle', 'author'],
    });

    expect(result.search).toBe('svelte');
    expect(result.filters).toEqual({
      __or: 'title.ilike.*svelte*,subtitle.ilike.*svelte*,author.ilike.*svelte*',
    });
  });

  it('drops the __or filter when ?q= is set but searchFields is empty', () => {
    const result = parseListParamsFromUrl({
      url: new URL('http://app.example/tables/public.numeric?q=42'),
      searchFields: [],
    });

    expect(result.search).toBe('42');
    expect(result.filters).toEqual({});
  });

  it('parses a multi-column ?sort= into an ordered SortSpec[] (default order = asc)', () => {
    const result = parseListParamsFromUrl({
      url: new URL(
        'http://app.example/tables/public.books?sort=title:asc,created_at:desc,author',
      ),
      searchFields: [],
    });

    expect(result.sort).toEqual([
      { field: 'title', order: 'asc' },
      { field: 'created_at', order: 'desc' },
      { field: 'author', order: 'asc' },
    ]);
  });

  it('clamps ?page= / ?pageSize= to a positive integer (silently falls back on garbage)', () => {
    const tableUrl = (qs: string): URL =>
      new URL(`http://app.example/tables/public.books${qs}`);

    expect(
      parseListParamsFromUrl({ url: tableUrl('?page=3&pageSize=25'), searchFields: [] }),
    ).toMatchObject({ page: 3, pageSize: 25 });

    expect(
      parseListParamsFromUrl({ url: tableUrl('?page=0&pageSize=-5'), searchFields: [] }),
    ).toMatchObject({ page: 1, pageSize: 50 });

    expect(
      parseListParamsFromUrl({
        url: tableUrl('?page=abc&pageSize=NaN'),
        searchFields: [],
      }),
    ).toMatchObject({ page: 1, pageSize: 50 });
  });
});
