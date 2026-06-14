import { describe, expect, it } from 'vitest';

import {
  buildHref,
  buildSortHref,
  formatCell,
  type ListViewParams,
} from '../../src/list/list-href.js';

const base: ListViewParams = { search: '', sort: [], page: 1, pageSize: 50 };

describe('buildHref', () => {
  it('returns "." when no params are active', () => {
    expect(buildHref(base)).toBe('.');
  });

  it('serialises search / sort / page / non-default pageSize', () => {
    expect(
      buildHref({
        search: 'foo',
        sort: [{ field: 'name', order: 'desc' }],
        page: 3,
        pageSize: 25,
      }),
    ).toBe('?q=foo&sort=name%3Adesc&page=3&pageSize=25');
  });

  it('omits pageSize when it equals the default (50)', () => {
    expect(buildHref({ ...base, page: 2 })).toBe('?page=2');
  });

  it('applies overrides and deletes keys set to null', () => {
    expect(buildHref({ ...base, page: 4 }, { page: null })).toBe('.');
    expect(buildHref(base, { q: 'x' })).toBe('?q=x');
  });
});

describe('buildSortHref', () => {
  it('toggles asc -> desc and resets the page', () => {
    expect(
      buildSortHref(
        { ...base, sort: [{ field: 'name', order: 'asc' }], page: 5 },
        'name',
      ),
    ).toBe('?sort=name%3Adesc');
  });

  it('defaults to asc for an unsorted column', () => {
    expect(buildSortHref(base, 'name')).toBe('?sort=name%3Aasc');
  });
});

describe('formatCell', () => {
  it('renders null / undefined as the empty string', () => {
    expect(formatCell(null)).toBe('');
    expect(formatCell(undefined)).toBe('');
  });

  it('JSON-stringifies objects', () => {
    expect(formatCell({ a: 1 })).toBe('{"a":1}');
  });

  it('stringifies primitives', () => {
    expect(formatCell(42)).toBe('42');
    expect(formatCell('hi')).toBe('hi');
  });
});
