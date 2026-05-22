import { describe, it, expect, vi, beforeEach } from 'vitest';
import { extractCheckEnums } from '../src/checkEnum.js';

describe('extractCheckEnums', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('IN 形式 → 値抽出', () => {
    const m = extractCheckEnums([
      { name: 'inv_status_check', expression: "status IN ('for_sale', 'reserved', 'sold')" },
    ]);
    expect(m.get('status')).toEqual(['for_sale', 'reserved', 'sold']);
  });

  it('= ANY (ARRAY[...]) 形式 (PG 16 正規化後) → 値抽出', () => {
    const m = extractCheckEnums([
      {
        name: 'inv_status_check',
        expression: "(status)::text = ANY (ARRAY['for_sale'::text, 'reserved'::text, 'sold'::text])",
      },
    ]);
    expect(m.get('status')).toEqual(['for_sale', 'reserved', 'sold']);
  });

  it('column-level + table-level CHECK 両方', () => {
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

  it('パース失敗 (BETWEEN 等) → skip', () => {
    const m = extractCheckEnums([
      { name: 'year_check', expression: 'year BETWEEN 1000 AND 2100' },
    ]);
    expect(m.size).toBe(0);
  });

  it('同一列に複数 CHECK → 最後勝ち + warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const m = extractCheckEnums([
      { name: 'first', expression: "status IN ('a')" },
      { name: 'second', expression: "status IN ('b')" },
    ]);
    expect(m.get('status')).toEqual(['b']);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/列 "status" に複数の enum CHECK/),
    );
  });

  it('空 CHECK 配列 → 空 Map', () => {
    expect(extractCheckEnums([]).size).toBe(0);
  });

  it('値がエスケープされた single quote を含む', () => {
    const m = extractCheckEnums([
      { name: 'apos', expression: "tag IN ('it''s', 'foo')" },
    ]);
    expect(m.get('tag')).toEqual(["it's", 'foo']);
  });
});
