import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseCommentTags } from '../src/parseCommentTags.js';

describe('parseCommentTags', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('null comment -> default fields', () => {
    const r = parseCommentTags(null);
    expect(r).toEqual({ body: '', ai: [], widget: null, policy: [], examples: [] });
  });

  it('empty string -> default fields', () => {
    const r = parseCommentTags('');
    expect(r).toEqual({ body: '', ai: [], widget: null, policy: [], examples: [] });
  });

  it('plain text with no tags -> body retains the text, tag fields empty', () => {
    const r = parseCommentTags('Inventory item. Manages selling price.');
    expect(r.body).toBe('Inventory item. Manages selling price.');
    expect(r.ai).toEqual([]);
    expect(r.widget).toBeNull();
    expect(r.policy).toEqual([]);
    expect(r.examples).toEqual([]);
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

  it('@example with description + indented SQL -> single example, body excludes it', () => {
    const r = parseCommentTags(
      'View of active stock.\n' +
        '@example: List items for sale by author\n' +
        '  SELECT id, selling_price\n' +
        '  FROM vw_inventory_for_sale\n' +
        '  ORDER BY author_name;',
    );
    expect(r.examples).toEqual([
      {
        description: 'List items for sale by author',
        sql:
          'SELECT id, selling_price\n' +
          'FROM vw_inventory_for_sale\n' +
          'ORDER BY author_name;',
      },
    ]);
    expect(r.body).toContain('View of active stock.');
    expect(r.body).not.toContain('@example');
    expect(r.body).not.toContain('SELECT');
  });

  it('@example with empty description -> description: "" + indented SQL captured', () => {
    const r = parseCommentTags(
      '@example:\n  SELECT * FROM books WHERE deleted_at IS NULL;',
    );
    expect(r.examples).toEqual([
      {
        description: '',
        sql: 'SELECT * FROM books WHERE deleted_at IS NULL;',
      },
    ]);
  });

  it('@example with no continuation -> description captured, sql empty', () => {
    // Convention is description first / SQL indented; a tag with no
    // indented body therefore yields an empty sql rather than treating
    // the tag-line text as SQL.
    const r = parseCommentTags('@example: TBD');
    expect(r.examples).toEqual([{ description: 'TBD', sql: '' }]);
  });

  it('multiple @example blocks -> each captured in order', () => {
    const r = parseCommentTags(
      '@example: First\n' +
        '  SELECT 1;\n' +
        '@example: Second\n' +
        '  SELECT 2;\n',
    );
    expect(r.examples).toEqual([
      { description: 'First', sql: 'SELECT 1;' },
      { description: 'Second', sql: 'SELECT 2;' },
    ]);
  });

  it('@example block terminates on a non-indented body line', () => {
    const r = parseCommentTags(
      'View of stock.\n' +
        '@example: A query\n' +
        '  SELECT 1;\n' +
        'Trailing remark.',
    );
    expect(r.examples).toEqual([
      { description: 'A query', sql: 'SELECT 1;' },
    ]);
    expect(r.body).toContain('Trailing remark.');
  });

  it('@example dedents the longest common leading whitespace', () => {
    const r = parseCommentTags(
      '@example: Indented SQL\n' +
        '    SELECT a,\n' +
        '           b\n' +
        '    FROM t;',
    );
    expect(r.examples).toEqual([
      {
        description: 'Indented SQL',
        sql: 'SELECT a,\n       b\nFROM t;',
      },
    ]);
  });

  it('all tags mixed', () => {
    const r = parseCommentTags(
      'Selling price.\n' +
        '@ai: differs from catalog_price\n' +
        '@widget: currency\n' +
        '@policy: pre-tax\n' +
        '@example: Pull selling price for an item\n' +
        '  SELECT selling_price FROM inventory_items;',
    );
    expect(r.ai).toEqual(['differs from catalog_price']);
    expect(r.widget).toBe('currency');
    expect(r.policy).toEqual(['pre-tax']);
    expect(r.examples).toEqual([
      {
        description: 'Pull selling price for an item',
        sql: 'SELECT selling_price FROM inventory_items;',
      },
    ]);
    expect(r.body).toContain('Selling price.');
    expect(r.body).toContain('@ai: differs from catalog_price');
    expect(r.body).not.toContain('@widget');
    expect(r.body).toContain('@policy: pre-tax');
    expect(r.body).not.toContain('@example');
    expect(r.body).not.toContain('SELECT');
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
