import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseCommentTags } from '../src/parseCommentTags.js';

describe('parseCommentTags', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('null comment -> default fields', () => {
    const r = parseCommentTags(null);
    expect(r).toEqual({
      body: '',
      ai: [],
      widget: null,
      policy: [],
      examples: [],
      expose: 'none',
      args: [],
    });
  });

  it('empty string -> default fields', () => {
    const r = parseCommentTags('');
    expect(r).toEqual({
      body: '',
      ai: [],
      widget: null,
      policy: [],
      examples: [],
      expose: 'none',
      args: [],
    });
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

  it('multi-line @ai block -> captured whole (not just the first line), kept in body', () => {
    const r = parseCommentTags(
      'Artists master.\n' +
        '@ai: display_name is the public label, legal_name is internal.\n' +
        '     treat death_year IS NULL as still active.\n' +
        '     exclude rows where deleted_at IS NOT NULL.',
    );
    expect(r.ai).toEqual([
      'display_name is the public label, legal_name is internal.\n' +
        'treat death_year IS NULL as still active.\n' +
        'exclude rows where deleted_at IS NOT NULL.',
    ]);
    // The whole block stays in the body too (forward compat).
    expect(r.body).toContain('@ai: display_name is the public label');
    expect(r.body).toContain('treat death_year IS NULL as still active.');
    expect(r.body).toContain('exclude rows where deleted_at IS NOT NULL.');
  });

  it('@ai block ends at a blank line', () => {
    const r = parseCommentTags('@ai: first line\n  second line\n\nUnrelated trailing prose.');
    expect(r.ai).toEqual(['first line\nsecond line']);
    expect(r.body).toContain('Unrelated trailing prose.');
  });

  it('@ai block ends at a non-indented line', () => {
    const r = parseCommentTags('@ai: note line\nNot indented, so body.');
    expect(r.ai).toEqual(['note line']);
    expect(r.body).toContain('Not indented, so body.');
  });

  it('@ai and @policy multi-line blocks each end at the next tag', () => {
    const r = parseCommentTags(
      '@ai: ai note\n  ai continued\n@policy: policy note\n  policy continued',
    );
    expect(r.ai).toEqual(['ai note\nai continued']);
    expect(r.policy).toEqual(['policy note\npolicy continued']);
  });

  it('multi-line @policy block -> captured whole', () => {
    const r = parseCommentTags(
      '@policy: never reuse a number once assigned.\n     blank stays allowed.',
    );
    expect(r.policy).toEqual(['never reuse a number once assigned.\nblank stays allowed.']);
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

  it('@example block terminates on an indented known tag (not captured as SQL) (#71)', () => {
    const r = parseCommentTags(
      '@example: get active rows\n' +
        '  SELECT 1;\n' +
        '  @ai: this note must not be swallowed into the example SQL\n' +
        '  @policy: nor this one',
    );
    // The example keeps only its SQL; the indented tags are lifted out into
    // their own fields rather than absorbed (and leaked) as example text.
    expect(r.examples).toEqual([{ description: 'get active rows', sql: 'SELECT 1;' }]);
    expect(r.ai).toEqual(['this note must not be swallowed into the example SQL']);
    expect(r.policy).toEqual(['nor this one']);
    expect(r.examples[0]!.sql).not.toContain('@ai');
  });

  it('an indented unknown @token inside an @example stays SQL (#71)', () => {
    const r = parseCommentTags(
      '@example: demo\n  SELECT 1;\n  @notatag: still part of the example',
    );
    expect(r.examples).toHaveLength(1);
    expect(r.examples[0]!.sql).toContain('@notatag: still part of the example');
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

  describe('mid-line tags (recognized at line start only)', () => {
    it('a known tag mid-line is not parsed, stays in body, and warns', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const r = parseCommentTags('Free-form notes. @widget: textarea');
      expect(r.widget).toBeNull();
      expect(r.body).toBe('Free-form notes. @widget: textarea');
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0]![0]).toMatch(/mid-line "@widget:" is not parsed/);
    });

    it('the same tag at line start parses without a warning', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const r = parseCommentTags('Free-form notes.\n@widget: textarea');
      expect(r.widget).toBe('textarea');
      expect(warn).not.toHaveBeenCalled();
    });

    it('does not warn inside an @example block (SQL legitimately contains @ text)', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const r = parseCommentTags(
        "Sales view.\n@example: literal tags in SQL\n  SELECT '@widget: text' AS note;",
      );
      expect(r.examples).toHaveLength(1);
      expect(r.examples[0]!.sql).toContain("'@widget: text'");
      expect(warn).not.toHaveBeenCalled();
    });

    it('warns on a mid-line tag inside an @ai continuation line (content still captured)', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const r = parseCommentTags('@ai: first line\n  also see @policy: something');
      expect(r.ai).toEqual(['first line\nalso see @policy: something']);
      expect(r.policy).toEqual([]);
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0]![0]).toMatch(/mid-line "@policy:"/);
    });

    it('does not warn on unknown tokens or email-like text', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const r = parseCommentTags('Contact someone@example.com or see @todo: later');
      expect(r.body).toBe('Contact someone@example.com or see @todo: later');
      expect(warn).not.toHaveBeenCalled();
    });

    it('matches the tag token case-insensitively, like line-start tags', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      parseCommentTags('note @Widget: textarea');
      expect(warn).toHaveBeenCalledOnce();
    });

    it('warns once per offending line', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      parseCommentTags('a @ai: x and @widget: y\nplain line\nmore @policy: z');
      expect(warn).toHaveBeenCalledTimes(2);
    });

    it('warns when a known tag is embedded in a tag-line value (@ai)', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const r = parseCommentTags('@ai: note @policy: secret');
      // The embedded tag is NOT parsed — the literal text stays in the value.
      expect(r.policy).toEqual([]);
      expect(r.ai).toEqual(['note @policy: secret']);
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0]![0]).toMatch(/mid-line "@policy:"/);
    });

    it('warns when a known tag is embedded in an @example description', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const r = parseCommentTags('@example: desc @widget: textarea\n  SELECT 1;');
      expect(r.widget).toBeNull();
      expect(r.examples[0]!.description).toBe('desc @widget: textarea');
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0]![0]).toMatch(/mid-line "@widget:"/);
    });

    it('stays linear on adversarial dense-@ input', () => {
      // A quadratic detector stalls on this shape (prefix re-scans per @);
      // the single-pass scan finishes instantly. Guarded by the test
      // timeout — quadratic behavior here costs tens of seconds.
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const dense = `x ${'@'.repeat(200_000)}`;
      const r = parseCommentTags(dense);
      expect(r.body).toBe(dense);
      expect(warn).not.toHaveBeenCalled();

      const identifiers = `x ${'@aaaaaaaa'.repeat(25_000)}`;
      const r2 = parseCommentTags(identifiers);
      expect(r2.body).toBe(identifiers);
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('@expose (RPC exposure marker, issue #103)', () => {
    it('absent -> expose: none', () => {
      expect(parseCommentTags('Approve an order.').expose).toBe('none');
    });

    it('@expose: rpc -> rpc', () => {
      const r = parseCommentTags('Approve an order.\n@expose: rpc');
      expect(r.expose).toBe('rpc');
      // The directive is lifted out of body (like @widget), not retained.
      expect(r.body).toBe('Approve an order.');
    });

    it('@expose: rpc public -> rpc-public', () => {
      expect(parseCommentTags('@expose: rpc public').expose).toBe('rpc-public');
    });

    it('is case-insensitive and whitespace-tolerant', () => {
      expect(parseCommentTags('@expose: RPC').expose).toBe('rpc');
      expect(parseCommentTags('@expose:  rpc   public  ').expose).toBe('rpc-public');
    });

    it('last @expose wins', () => {
      expect(parseCommentTags('@expose: rpc\n@expose: rpc public').expose).toBe('rpc-public');
    });

    it('invalid value warns and stays none', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const r = parseCommentTags('@expose: graphql');
      expect(r.expose).toBe('none');
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0]![0]).toMatch(/invalid @expose value "graphql"/);
    });

    it('fails closed: a later invalid value resets an earlier valid exposure', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      // A malformed change must not leave the prior allow active.
      expect(parseCommentTags('@expose: rpc\n@expose: disabled').expose).toBe('none');
      expect(warn).toHaveBeenCalled();
    });
  });

  describe('@arg (function argument hints, issue #103)', () => {
    it('absent -> args: []', () => {
      expect(parseCommentTags('Approve an order.').args).toEqual([]);
    });

    it('relation(table.col) -> schema null (defaulted by the builder)', () => {
      const r = parseCommentTags('@arg: order_id relation(orders.id)');
      expect(r.args).toEqual([
        { name: 'order_id', relation: { schema: null, table: 'orders', column: 'id' } },
      ]);
    });

    it('relation(schema.table.col) -> fully qualified', () => {
      const r = parseCommentTags('@arg: order_id relation(public.orders.id)');
      expect(r.args).toEqual([
        { name: 'order_id', relation: { schema: 'public', table: 'orders', column: 'id' } },
      ]);
    });

    it('widget(<type>) -> widget hint', () => {
      const r = parseCommentTags('@arg: note widget(textarea)');
      expect(r.args).toEqual([{ name: 'note', widget: 'textarea' }]);
    });

    it('collects multiple @arg hints in source order, lifted out of body', () => {
      const r = parseCommentTags(
        'Approve.\n@arg: order_id relation(orders.id)\n@arg: status widget(enum-select)',
      );
      expect(r.args.map((a) => a.name)).toEqual(['order_id', 'status']);
      expect(r.body).toBe('Approve.');
    });

    it('warns and skips a malformed relation ref (wrong part count)', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const r = parseCommentTags('@arg: x relation(a.b.c.d)');
      expect(r.args).toEqual([]);
      expect(warn.mock.calls[0]![0]).toMatch(/invalid @arg value/);
    });

    it('warns and skips an unknown widget', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(parseCommentTags('@arg: x widget(bogus)').args).toEqual([]);
      expect(warn).toHaveBeenCalledOnce();
    });

    it('warns and skips an unknown directive', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(parseCommentTags('@arg: x default(1)').args).toEqual([]);
      expect(warn).toHaveBeenCalledOnce();
    });

    it('warns and skips a bare name with no directive', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(parseCommentTags('@arg: order_id').args).toEqual([]);
      expect(warn).toHaveBeenCalledOnce();
    });
  });

  // Regression: a colon is required on every tag, and a colon-less known token
  // is treated uniformly (left in `body`, never captured). An earlier report
  // observed an @ai/@policy asymmetry; the tag parser recognizes tags only via
  // TAG_RE (colon-mandatory) for all tags, so the behaviour is symmetric. These
  // lock that in so the asymmetry cannot regress.
  describe('colon requirement is symmetric across tags', () => {
    it('colon-less @ai is not captured and stays in body', () => {
      const r = parseCommentTags('An item.\n@ai note without a colon');
      expect(r.ai).toEqual([]);
      expect(r.body).toContain('@ai note without a colon');
    });

    it('colon-less @policy is not captured and stays in body', () => {
      const r = parseCommentTags('An item.\n@policy note without a colon');
      expect(r.policy).toEqual([]);
      expect(r.body).toContain('@policy note without a colon');
    });

    it('@ai and @policy behave identically with and without a colon', () => {
      const aiNo = parseCommentTags('@ai x');
      const polNo = parseCommentTags('@policy x');
      expect(aiNo.ai).toEqual([]);
      expect(polNo.policy).toEqual([]);

      const aiYes = parseCommentTags('@ai: x');
      const polYes = parseCommentTags('@policy: x');
      expect(aiYes.ai).toEqual(['x']);
      expect(polYes.policy).toEqual(['x']);
    });
  });
});
