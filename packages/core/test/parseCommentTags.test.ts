import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseCommentTags } from '../src/parseCommentTags.js';

describe('parseCommentTags', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('null comment -> default fields', () => {
    const r = parseCommentTags(null);
    expect(r).toEqual({ body: '', ai: [], widget: null, policy: [] });
  });

  it('empty string -> default fields', () => {
    const r = parseCommentTags('');
    expect(r).toEqual({ body: '', ai: [], widget: null, policy: [] });
  });

  it('plain text with no tags -> body retains the text, tag fields empty', () => {
    const r = parseCommentTags('Inventory item. Manages selling price.');
    expect(r.body).toBe('Inventory item. Manages selling price.');
    expect(r.ai).toEqual([]);
    expect(r.widget).toBeNull();
    expect(r.policy).toEqual([]);
  });

  it('single @ai line -> pushed to ai, kept in body', () => {
    const r = parseCommentTags('Inventory item.\n@ai: prefer vw_inventory_for_sale');
    expect(r.ai).toEqual(['prefer vw_inventory_for_sale']);
    expect(r.body).toContain('Inventory item.');
    expect(r.body).toContain('@ai: prefer vw_inventory_for_sale');
  });

  it('multiple @ai lines -> each captured', () => {
    const r = parseCommentTags('@ai: instruction one\n@ai: instruction two');
    expect(r.ai).toEqual(['instruction one', 'instruction two']);
  });

  it('single @widget -> widget set, line removed from body', () => {
    const r = parseCommentTags('Inventory status.\n@widget: enum-select');
    expect(r.widget).toBe('enum-select');
    expect(r.body).not.toContain('@widget');
    expect(r.body).toContain('Inventory status.');
  });

  it('multiple @widget -> last one wins', () => {
    const r = parseCommentTags('@widget: text\n@widget: currency');
    expect(r.widget).toBe('currency');
  });

  it('invalid @widget value -> warn + null', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = parseCommentTags('@widget: not-a-widget');
    expect(r.widget).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toMatch(/invalid @widget/);
  });

  it('single @policy line -> pushed to policy, kept in body', () => {
    const r = parseCommentTags('Pricing info.\n@policy: internal use only');
    expect(r.policy).toEqual(['internal use only']);
    expect(r.body).toContain('@policy: internal use only');
  });

  it('multiple @policy lines -> each captured', () => {
    const r = parseCommentTags('@policy: rule one\n@policy: rule two');
    expect(r.policy).toEqual(['rule one', 'rule two']);
  });

  it('@example (unknown tag) -> warn + kept in body', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = parseCommentTags('Listing.\n@example: SELECT * FROM t;');
    expect(r.body).toContain('@example: SELECT * FROM t;');
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toMatch(/unknown tag/);
  });

  it('all tags mixed', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = parseCommentTags(
      'Selling price.\n' +
        '@ai: differs from catalog_price\n' +
        '@widget: currency\n' +
        '@policy: pre-tax\n' +
        '@example: SELECT selling_price FROM inventory_items',
    );
    expect(r.ai).toEqual(['differs from catalog_price']);
    expect(r.widget).toBe('currency');
    expect(r.policy).toEqual(['pre-tax']);
    expect(r.body).toContain('Selling price.');
    expect(r.body).toContain('@ai: differs from catalog_price');
    expect(r.body).not.toContain('@widget');
    expect(r.body).toContain('@policy: pre-tax');
    expect(r.body).toContain('@example: SELECT');
    expect(warn).toHaveBeenCalledOnce();
  });

  it('leading whitespace before a tag is allowed', () => {
    const r = parseCommentTags('   @widget: text');
    expect(r.widget).toBe('text');
  });

  it('@widget value is trimmed', () => {
    const r = parseCommentTags('@widget:   number   ');
    expect(r.widget).toBe('number');
  });

  it('trailing whitespace is trimmed from body', () => {
    const r = parseCommentTags('text\n\n  \n');
    expect(r.body).toBe('text');
  });
});
