import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseCommentTags } from '../src/parseCommentTags.js';

describe('parseCommentTags', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('null comment → 全 field 初期値', () => {
    const r = parseCommentTags(null);
    expect(r).toEqual({ body: '', ai: [], widget: null, policy: [] });
  });

  it('空文字 → 全 field 初期値', () => {
    const r = parseCommentTags('');
    expect(r).toEqual({ body: '', ai: [], widget: null, policy: [] });
  });

  it('tag なし pure text → body に同じ内容、tag fields は空', () => {
    const r = parseCommentTags('在庫個体。販売価格を管理する。');
    expect(r.body).toBe('在庫個体。販売価格を管理する。');
    expect(r.ai).toEqual([]);
    expect(r.widget).toBeNull();
    expect(r.policy).toEqual([]);
  });

  it('@ai 単一行 → ai に push、body にも残す', () => {
    const r = parseCommentTags('在庫個体。\n@ai: vw_inventory_for_sale を優先');
    expect(r.ai).toEqual(['vw_inventory_for_sale を優先']);
    expect(r.body).toContain('在庫個体。');
    expect(r.body).toContain('@ai: vw_inventory_for_sale を優先');
  });

  it('@ai 複数行 → 各行が ai に', () => {
    const r = parseCommentTags('@ai: instruction one\n@ai: instruction two');
    expect(r.ai).toEqual(['instruction one', 'instruction two']);
  });

  it('@widget 単一 → widget 設定、body から除去', () => {
    const r = parseCommentTags('在庫状態。\n@widget: enum-select');
    expect(r.widget).toBe('enum-select');
    expect(r.body).not.toContain('@widget');
    expect(r.body).toContain('在庫状態。');
  });

  it('@widget 複数 → 最後勝ち', () => {
    const r = parseCommentTags('@widget: text\n@widget: currency');
    expect(r.widget).toBe('currency');
  });

  it('@widget 無効値 → warn + null', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = parseCommentTags('@widget: not-a-widget');
    expect(r.widget).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toMatch(/無効な @widget/);
  });

  it('@policy 単一行 → policy に push、body に残す', () => {
    const r = parseCommentTags('価格情報。\n@policy: 内部のみ参照');
    expect(r.policy).toEqual(['内部のみ参照']);
    expect(r.body).toContain('@policy: 内部のみ参照');
  });

  it('@policy 複数行 → 各行が policy に', () => {
    const r = parseCommentTags('@policy: rule one\n@policy: rule two');
    expect(r.policy).toEqual(['rule one', 'rule two']);
  });

  it('@example (未定義 tag) → warn + body 残置', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = parseCommentTags('一覧。\n@example: SELECT * FROM t;');
    expect(r.body).toContain('@example: SELECT * FROM t;');
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toMatch(/未定義 tag/);
  });

  it('全 tag 混在', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = parseCommentTags(
      '販売価格。\n' +
        '@ai: catalog_price とは別\n' +
        '@widget: currency\n' +
        '@policy: 税抜\n' +
        '@example: SELECT selling_price FROM inventory_items',
    );
    expect(r.ai).toEqual(['catalog_price とは別']);
    expect(r.widget).toBe('currency');
    expect(r.policy).toEqual(['税抜']);
    expect(r.body).toContain('販売価格。');
    expect(r.body).toContain('@ai: catalog_price とは別');
    expect(r.body).not.toContain('@widget');
    expect(r.body).toContain('@policy: 税抜');
    expect(r.body).toContain('@example: SELECT');
    expect(warn).toHaveBeenCalledOnce();
  });

  it('tag 前の空白を許容', () => {
    const r = parseCommentTags('   @widget: text');
    expect(r.widget).toBe('text');
  });

  it('@widget の value は trim される', () => {
    const r = parseCommentTags('@widget:   number   ');
    expect(r.widget).toBe('number');
  });

  it('末尾空白は body から trim', () => {
    const r = parseCommentTags('テキスト\n\n  \n');
    expect(r.body).toBe('テキスト');
  });
});
