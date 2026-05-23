import { describe, it, expect, vi, beforeEach } from 'vitest';
import { extractCheckEnums } from '../src/checkEnum.js';

describe('extractCheckEnums', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('IN form -> extracts values', () => {
    const m = extractCheckEnums([
      { name: 'inv_status_check', expression: "status IN ('for_sale', 'reserved', 'sold')" },
    ]);
    expect(m.get('status')).toEqual(['for_sale', 'reserved', 'sold']);
  });

  it('= ANY (ARRAY[...]) form (PG 16 normalised) -> extracts values', () => {
    const m = extractCheckEnums([
      {
        name: 'inv_status_check',
        expression: "(status)::text = ANY (ARRAY['for_sale'::text, 'reserved'::text, 'sold'::text])",
      },
    ]);
    expect(m.get('status')).toEqual(['for_sale', 'reserved', 'sold']);
  });

  it('column-level + table-level CHECK both extracted', () => {
    const m = extractCheckEnums([
      {
        name: 'a_status',
        expression: "status = ANY (ARRAY['a'::text, 'b'::text])",
      },
      {
        name: 'a_visibility',
        expression: "visibility IN ('public', 'private')",
      },
    ]);
    expect(m.get('status')).toEqual(['a', 'b']);
    expect(m.get('visibility')).toEqual(['public', 'private']);
  });

  it('unparseable expression (e.g. BETWEEN) is skipped', () => {
    const m = extractCheckEnums([
      { name: 'year_check', expression: 'year BETWEEN 1000 AND 2100' },
    ]);
    expect(m.size).toBe(0);
  });

  it('multiple CHECKs on the same column: last one wins + warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const m = extractCheckEnums([
      { name: 'first', expression: "status IN ('a')" },
      { name: 'second', expression: "status IN ('b')" },
    ]);
    expect(m.get('status')).toEqual(['b']);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/column "status" has multiple enum CHECK/),
    );
  });

  it('empty CHECK array -> empty Map', () => {
    expect(extractCheckEnums([]).size).toBe(0);
  });

  it('values can contain escaped single quotes', () => {
    const m = extractCheckEnums([
      { name: 'apos', expression: "tag IN ('it''s', 'foo')" },
    ]);
    expect(m.get('tag')).toEqual(["it's", 'foo']);
  });
});
