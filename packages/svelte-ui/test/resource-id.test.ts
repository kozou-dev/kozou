import { describe, expect, it } from 'vitest';

import {
  encodeResourceId,
  parseResourceId,
  rowIdSegment,
} from '../src/lib/resource-id.js';

describe('rowIdSegment', () => {
  it('returns the encoded value for a single-column key', () => {
    expect(rowIdSegment({ id: 'abc', name: 'X' }, ['id'])).toBe('abc');
  });

  it('comma-joins the components of a composite key in declaration order', () => {
    expect(
      rowIdSegment({ order_id: 100, line_no: 2, qty: 5 }, ['order_id', 'line_no']),
    ).toBe('100,2');
  });

  it('percent-encodes each component but never the separator comma', () => {
    expect(
      rowIdSegment({ a: 'x/y', b: 'p q' }, ['a', 'b']),
    ).toBe('x%2Fy,p%20q');
  });

  it('returns null for an empty primary key (e.g. a view)', () => {
    expect(rowIdSegment({ id: 1 }, [])).toBeNull();
  });

  it('returns null when any key column is missing or null', () => {
    expect(rowIdSegment({ order_id: 100, line_no: null }, ['order_id', 'line_no'])).toBeNull();
    expect(rowIdSegment({ order_id: 100 }, ['order_id', 'line_no'])).toBeNull();
  });
});

describe('encodeResourceId', () => {
  it('encodes a scalar id', () => {
    expect(encodeResourceId('a b')).toBe('a%20b');
    expect(encodeResourceId(7)).toBe('7');
  });

  it('comma-joins an array id with per-component encoding', () => {
    expect(encodeResourceId(['100', '2'])).toBe('100,2');
    expect(encodeResourceId(['x/y', 'z'])).toBe('x%2Fy,z');
  });
});

describe('parseResourceId', () => {
  it('passes a single-column key through verbatim (commas kept)', () => {
    expect(parseResourceId('a,b', ['id'])).toBe('a,b');
    expect(parseResourceId('abc', ['id'])).toBe('abc');
  });

  it('splits a composite key on commas', () => {
    expect(parseResourceId('100,2', ['order_id', 'line_no'])).toEqual(['100', '2']);
  });

  it('round-trips with encodeResourceId for the no-comma-in-value case', () => {
    const pk = ['order_id', 'line_no'];
    expect(encodeResourceId(parseResourceId('100,2', pk))).toBe('100,2');
  });
});

describe('composite key value containing a comma (documented limitation)', () => {
  // A composite key value cannot contain a comma,
  // because SvelteKit (and the in-house API handler) URL-decode the whole
  // `[id]` segment before splitting on commas. This test pins the behaviour
  // so the limitation stays *contained* — a comma inflates the component
  // count past the key arity, which downstream surfaces as a loud arity
  // error rather than silently addressing the wrong row.
  it('inflates the component count after decode, breaking the arity (no silent wrong row)', () => {
    const pk = ['order_id', 'line_no'];
    // A row whose first key component legitimately contains a comma.
    const segment = rowIdSegment({ order_id: 'a,b', line_no: 'c' }, pk);
    expect(segment).toBe('a%2Cb,c');

    // SvelteKit decodes the whole param before the route load sees it.
    const decoded = decodeURIComponent(segment as string);
    expect(decoded).toBe('a,b,c');

    const parsed = parseResourceId(decoded, pk) as string[];
    expect(parsed).toEqual(['a', 'b', 'c']);
    // 3 components for a 2-column key -> the adapter/server rejects it.
    expect(parsed.length).not.toBe(pk.length);
  });

  it('a single-column key keeps a comma value verbatim (unaffected)', () => {
    expect(parseResourceId('a,b', ['id'])).toBe('a,b');
  });
});
