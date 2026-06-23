import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RawCheck, RawColumn, RawForeignKey, RawIndex, RawIntrospection, RawTable, RawView, UIHints } from '../src/index.js';
import { buildSchemaContext, KozouBuildError } from '../src/buildSchemaContext.js';

function makeCol(name: string, udtName: string, overrides: Partial<RawColumn> = {}): RawColumn {
  return {
    name,
    dataType: udtName,
    udtName,
    nullable: true,
    defaultExpr: null,
    comment: null,
    position: 1,
    ...overrides,
  };
}

function makeTable(name: string, overrides: Partial<RawTable> = {}): RawTable {
  return {
    schema: 'public',
    name,
    comment: null,
    columns: [],
    primaryKey: [],
    foreignKeys: [],
    checks: [],
    indexes: [],
    rowCountEstimate: null,
    ...overrides,
  };
}

function makeRaw(overrides: Partial<RawIntrospection> = {}): RawIntrospection {
  return {
    serverVersion: '16.2',
    introspectedAt: '2026-01-01T00:00:00.000Z',
    schemas: ['public'],
    tables: [],
    views: [],
    enums: [],
    functions: [],
    ...overrides,
  };
}

describe('buildSchemaContext', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('basic shape (tables/views/enums/concepts counts)', async () => {
    const raw = makeRaw({
      tables: [makeTable('authors'), makeTable('books')],
      views: [
        {
          schema: 'public',
          name: 'vw_for_sale',
          comment: 'concept',
          columns: [],
          underlyingTables: [],
          definition: 'SELECT 1',
        },
      ],
      enums: [{ schema: 'public', name: 'status_enum', values: ['a', 'b'] }],
    });
    const ctx = await buildSchemaContext({ raw });
    expect(ctx.tables.map((t) => t.name)).toEqual(['authors', 'books']);
    expect(ctx.views.map((v) => v.name)).toEqual(['vw_for_sale']);
    expect(ctx.enums.map((e) => e.name)).toEqual(['status_enum']);
    expect(ctx.concepts).toHaveLength(1);
    expect(ctx.concepts[0]!.kind).toBe('VIEW');
    expect(ctx.meta.serverVersion).toBe('16.2');
    expect(ctx.meta.sourceSchemas).toEqual(['public']);
  });

  it('widget inference priority: UIHints > @widget > heuristic', async () => {
    const col1 = makeCol('status', 'text', { comment: '@widget: enum-select' });
    const col2 = makeCol('display_name', 'text');
    const raw = makeRaw({
      tables: [
        makeTable('authors', {
          columns: [col1, col2],
          primaryKey: ['id'],
        }),
      ],
    });
    const uiHints: UIHints = {
      tables: { authors: { columns: { display_name: { widget: 'currency' } } } },
    };
    const ctx = await buildSchemaContext({ raw, uiHints });
    const cols = ctx.tables[0]!.columns;
    expect(cols.find((c) => c.name === 'status')!.widget).toBe('enum-select');
    expect(cols.find((c) => c.name === 'display_name')!.widget).toBe('currency');
  });

  it('keys UIHints by schema-qualified name so same-named relations do not collide (#180)', async () => {
    // `public.users` and `audit.users` would share one hints entry if keyed by
    // the bare name; a schema-qualified key lets each carry its own label.
    const raw = makeRaw({
      schemas: ['public', 'audit'],
      tables: [
        makeTable('users', { schema: 'public', columns: [makeCol('id', 'uuid')], primaryKey: ['id'] }),
        makeTable('users', { schema: 'audit', columns: [makeCol('id', 'uuid')], primaryKey: ['id'] }),
      ],
    });
    const uiHints: UIHints = {
      tables: {
        'public.users': { label: 'People' },
        'audit.users': { label: 'Audit Trail' },
      },
    };
    // strict:true also proves the qualified keys are not flagged as hints on a
    // non-existent relation — without recognizing `schema.name` in validation
    // this build would throw before any label is applied.
    const ctx = await buildSchemaContext({ raw, uiHints, strict: true });
    const labelOf = (qn: string) => ctx.tables.find((t) => t.qualifiedName === qn)!.label;
    expect(labelOf('public.users')).toBe('People');
    expect(labelOf('audit.users')).toBe('Audit Trail');
  });

  it('accepts a schema-qualified UIHint key for a view under strict mode (#180)', async () => {
    const raw = makeRaw({
      views: [
        {
          schema: 'public',
          name: 'vw_active',
          comment: null,
          columns: [makeCol('id', 'uuid')],
          underlyingTables: [],
          definition: 'SELECT 1',
        },
      ],
    });
    const ctx = await buildSchemaContext({
      raw,
      uiHints: { views: { 'public.vw_active': { label: 'Active' } } },
      strict: true,
    });
    expect(ctx.views[0]!.label).toBe('Active');
  });

  it('still applies a bare-name UIHint to a single-schema relation (#180 back-compat)', async () => {
    const raw = makeRaw({
      tables: [makeTable('authors', { columns: [makeCol('id', 'uuid')], primaryKey: ['id'] })],
    });
    const ctx = await buildSchemaContext({
      raw,
      uiHints: { tables: { authors: { label: 'Writers' } } },
      strict: true,
    });
    expect(ctx.tables[0]!.label).toBe('Writers');
  });

  it('resolves a native ENUM column to its members (enum-select + enumValues)', async () => {
    const raw = makeRaw({
      enums: [{ schema: 'public', name: 'order_status', values: ['open', 'paid', 'shipped'] }],
      tables: [
        makeTable('orders', {
          columns: [makeCol('id', 'uuid'), makeCol('status', 'order_status', { nullable: false })],
          primaryKey: ['id'],
        }),
      ],
    });
    const ctx = await buildSchemaContext({ raw });
    const status = ctx.tables[0]!.columns.find((c) => c.name === 'status')!;
    // Same resolution as a function argument of the same type: by udtName.
    expect(status.enumValues).toEqual(['open', 'paid', 'shipped']);
    expect(status.nativeEnum).toBe(true);
    expect(status.widget).toBe('enum-select');
  });

  it('resolves a native ENUM column on a view as well', async () => {
    const raw = makeRaw({
      enums: [{ schema: 'public', name: 'order_status', values: ['open', 'paid'] }],
      views: [
        {
          schema: 'public',
          name: 'order_summary',
          comment: null,
          columns: [makeCol('status', 'order_status')],
          underlyingTables: [],
          definition: 'SELECT status FROM orders',
        },
      ],
    });
    const ctx = await buildSchemaContext({ raw });
    const status = ctx.views[0]!.columns.find((c) => c.name === 'status')!;
    expect(status.enumValues).toEqual(['open', 'paid']);
    expect(status.nativeEnum).toBe(true);
    expect(status.widget).toBe('enum-select');
  });

  it('a CHECK-constraint pseudo-enum takes precedence over a native ENUM type', async () => {
    const raw = makeRaw({
      enums: [{ schema: 'public', name: 'order_status', values: ['open', 'paid', 'shipped'] }],
      tables: [
        makeTable('orders', {
          columns: [makeCol('id', 'uuid'), makeCol('status', 'order_status')],
          primaryKey: ['id'],
          // A CHECK narrows the column further than the native type.
          checks: [{ name: 'orders_status_chk', expression: "status IN ('open', 'paid')" }],
        }),
      ],
    });
    const ctx = await buildSchemaContext({ raw });
    const status = ctx.tables[0]!.columns.find((c) => c.name === 'status')!;
    expect(status.enumValues).toEqual(['open', 'paid']);
    // CHECK-derived: not exhaustive, so not flagged as a native ENUM.
    expect(status.nativeEnum).toBe(false);
  });

  it('displayField inference (UIHints > heuristic)', async () => {
    const raw = makeRaw({
      tables: [
        makeTable('authors', {
          columns: [makeCol('id', 'uuid'), makeCol('display_name', 'text')],
          primaryKey: ['id'],
        }),
      ],
    });
    const noHints = await buildSchemaContext({ raw });
    expect(noHints.tables[0]!.displayField).toBe('display_name');

    const withHints = await buildSchemaContext({
      raw,
      uiHints: { tables: { authors: { displayField: 'id' } } },
    });
    expect(withHints.tables[0]!.displayField).toBe('id');
  });

  it('FK -> RelationContext (cardinality many-to-one)', async () => {
    const fk: RawForeignKey = {
      name: 'books_author_id_fkey',
      columns: ['author_id'],
      referencedSchema: 'public',
      referencedTable: 'authors',
      referencedColumns: ['id'],
      onDelete: 'NO ACTION',
      onUpdate: 'NO ACTION',
      comment: 'Reference to the author',
    };
    const raw = makeRaw({
      tables: [
        makeTable('authors', { columns: [makeCol('id', 'uuid')], primaryKey: ['id'] }),
        makeTable('books', {
          columns: [makeCol('author_id', 'uuid')],
          primaryKey: ['id'],
          foreignKeys: [fk],
        }),
      ],
    });
    const ctx = await buildSchemaContext({ raw });
    const books = ctx.tables.find((t) => t.name === 'books')!;
    expect(books.relations).toHaveLength(1);
    expect(books.relations[0]).toMatchObject({
      field: 'author_id',
      references: { schema: 'public', table: 'authors', column: 'id' },
      cardinality: 'many-to-one',
      meaning: 'Reference to the author',
    });
  });

  it('FK + UNIQUE index -> cardinality one-to-one', async () => {
    const fk: RawForeignKey = {
      name: 'fk1',
      columns: ['user_id'],
      referencedSchema: 'public',
      referencedTable: 'users',
      referencedColumns: ['id'],
      onDelete: 'NO ACTION',
      onUpdate: 'NO ACTION',
      comment: null,
    };
    const idx: RawIndex = { name: 'idx_user_unique', columns: ['user_id'], unique: true };
    const raw = makeRaw({
      tables: [
        makeTable('users', { columns: [makeCol('id', 'uuid')], primaryKey: ['id'] }),
        makeTable('profiles', {
          columns: [makeCol('user_id', 'uuid')],
          foreignKeys: [fk],
          indexes: [idx],
        }),
      ],
    });
    const ctx = await buildSchemaContext({ raw });
    const profiles = ctx.tables.find((t) => t.name === 'profiles')!;
    expect(profiles.relations[0]!.cardinality).toBe('one-to-one');
  });

  it('composite FK -> emitted as a relation with array fields, no warning (v1.1)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fk: RawForeignKey = {
      name: 'order_items_order_fkey',
      columns: ['order_id', 'order_line'],
      referencedSchema: 'public',
      referencedTable: 'orders',
      referencedColumns: ['id', 'line'],
      onDelete: 'NO ACTION',
      onUpdate: 'NO ACTION',
      comment: 'Reference to the parent order line',
    };
    const raw = makeRaw({
      tables: [
        makeTable('orders', {
          columns: [makeCol('id', 'uuid'), makeCol('line', 'int4')],
          primaryKey: ['id', 'line'],
        }),
        makeTable('order_items', {
          columns: [makeCol('order_id', 'uuid'), makeCol('order_line', 'int4')],
          foreignKeys: [fk],
        }),
      ],
    });
    const ctx = await buildSchemaContext({ raw });
    const orderItems = ctx.tables.find((t) => t.name === 'order_items')!;
    // Composite FK is now a relation: arrays carry both columns; the scalar
    // field / column keep [0] for back-compat.
    expect(orderItems.relations).toHaveLength(1);
    expect(orderItems.relations[0]).toMatchObject({
      field: 'order_id',
      fields: ['order_id', 'order_line'],
      references: { schema: 'public', table: 'orders', column: 'id', columns: ['id', 'line'] },
      cardinality: 'many-to-one',
      meaning: 'Reference to the parent order line',
    });
    // It is no longer excluded, so no "spans multiple columns" warning.
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringMatching(/spans multiple columns/),
    );
  });

  it('composite FK is valid under strict=true (no exclusion issue) (v1.1)', async () => {
    const fk: RawForeignKey = {
      name: 'order_items_order_fkey',
      columns: ['order_id', 'order_line'],
      referencedSchema: 'public',
      referencedTable: 'orders',
      referencedColumns: ['id', 'line'],
      onDelete: 'NO ACTION',
      onUpdate: 'NO ACTION',
      comment: null,
    };
    const raw = makeRaw({
      tables: [
        makeTable('orders', {
          columns: [makeCol('id', 'uuid'), makeCol('line', 'int4')],
          primaryKey: ['id', 'line'],
        }),
        makeTable('order_items', {
          columns: [makeCol('order_id', 'uuid'), makeCol('order_line', 'int4')],
          foreignKeys: [fk],
        }),
      ],
    });
    const ctx = await buildSchemaContext({ raw, strict: true });
    const orderItems = ctx.tables.find((t) => t.name === 'order_items')!;
    expect(orderItems.relations.map((r) => r.fields)).toEqual([['order_id', 'order_line']]);
  });

  it('skips a misaligned composite FK (column count != referenced count) with a BuildIssue (v1.1)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const misaligned: RawForeignKey = {
      name: 'order_items_order_fkey',
      columns: ['order_id', 'order_line'],
      referencedSchema: 'public',
      referencedTable: 'orders',
      referencedColumns: ['id'], // only one — not aligned with the two FK columns
      onDelete: 'NO ACTION',
      onUpdate: 'NO ACTION',
      comment: null,
    };
    const raw = makeRaw({
      tables: [
        makeTable('orders', { columns: [makeCol('id', 'uuid')], primaryKey: ['id'] }),
        makeTable('order_items', {
          columns: [makeCol('order_id', 'uuid'), makeCol('order_line', 'int4')],
          foreignKeys: [misaligned],
        }),
      ],
    });
    const ctx = await buildSchemaContext({ raw });
    expect(ctx.tables.find((t) => t.name === 'order_items')!.relations).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/not positionally aligned/));
  });

  it('misaligned composite FK throws under strict=true (v1.1)', async () => {
    const misaligned: RawForeignKey = {
      name: 'order_items_order_fkey',
      columns: ['order_id', 'order_line'],
      referencedSchema: 'public',
      referencedTable: 'orders',
      referencedColumns: ['id'],
      onDelete: 'NO ACTION',
      onUpdate: 'NO ACTION',
      comment: null,
    };
    const raw = makeRaw({
      tables: [
        makeTable('orders', { columns: [makeCol('id', 'uuid')], primaryKey: ['id'] }),
        makeTable('order_items', {
          columns: [makeCol('order_id', 'uuid'), makeCol('order_line', 'int4')],
          foreignKeys: [misaligned],
        }),
      ],
    });
    await expect(buildSchemaContext({ raw, strict: true })).rejects.toBeInstanceOf(KozouBuildError);
  });

  it('single- and composite-column FKs on one table both become relations (v1.1)', async () => {
    const singleFk: RawForeignKey = {
      name: 'order_items_product_fkey',
      columns: ['product_id'],
      referencedSchema: 'public',
      referencedTable: 'products',
      referencedColumns: ['id'],
      onDelete: 'NO ACTION',
      onUpdate: 'NO ACTION',
      comment: null,
    };
    const compositeFk: RawForeignKey = {
      name: 'order_items_order_fkey',
      columns: ['order_id', 'order_line'],
      referencedSchema: 'public',
      referencedTable: 'orders',
      referencedColumns: ['id', 'line'],
      onDelete: 'NO ACTION',
      onUpdate: 'NO ACTION',
      comment: null,
    };
    const raw = makeRaw({
      tables: [
        makeTable('products', { columns: [makeCol('id', 'uuid')], primaryKey: ['id'] }),
        makeTable('orders', {
          columns: [makeCol('id', 'uuid'), makeCol('line', 'int4')],
          primaryKey: ['id', 'line'],
        }),
        makeTable('order_items', {
          columns: [
            makeCol('order_id', 'uuid'),
            makeCol('order_line', 'int4'),
            makeCol('product_id', 'uuid'),
          ],
          foreignKeys: [singleFk, compositeFk],
        }),
      ],
    });
    const ctx = await buildSchemaContext({ raw });
    const orderItems = ctx.tables.find((t) => t.name === 'order_items')!;
    // Both FKs are now relations: the single-column product FK and the
    // composite order FK.
    expect(orderItems.relations).toHaveLength(2);
    expect(orderItems.relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'product_id',
          fields: ['product_id'],
          references: { schema: 'public', table: 'products', column: 'id', columns: ['id'] },
          cardinality: 'many-to-one',
        }),
        expect.objectContaining({
          field: 'order_id',
          fields: ['order_id', 'order_line'],
          references: { schema: 'public', table: 'orders', column: 'id', columns: ['id', 'line'] },
          cardinality: 'many-to-one',
        }),
      ]),
    );
    // Widget rework: only the single-column FK column is relation-selectable;
    // the composite-FK columns keep isForeignKey but get a type-based widget.
    const widgetOf = (name: string) => orderItems.columns.find((c) => c.name === name)!.widget;
    expect(widgetOf('product_id')).toBe('relation-select');
    expect(widgetOf('order_id')).toBe('uuid');
    expect(widgetOf('order_line')).toBe('number');
    // All FK columns remain isForeignKey = true (schema truth).
    for (const name of ['product_id', 'order_id', 'order_line']) {
      expect(orderItems.columns.find((c) => c.name === name)!.isForeignKey).toBe(true);
    }
  });

  it('CHECK -> enumValues + widget enum-select', async () => {
    const check: RawCheck = {
      name: 'status_check',
      expression: "status = ANY (ARRAY['for_sale'::text, 'reserved'::text])",
    };
    const raw = makeRaw({
      tables: [
        makeTable('inv', {
          columns: [makeCol('status', 'text')],
          checks: [check],
        }),
      ],
    });
    const ctx = await buildSchemaContext({ raw });
    const status = ctx.tables[0]!.columns[0]!;
    expect(status.enumValues).toEqual(['for_sale', 'reserved']);
    // CHECK-derived enumValues is not a native ENUM (not an exhaustive domain).
    expect(status.nativeEnum).toBe(false);
    expect(status.widget).toBe('enum-select');
  });

  it('strict=false: missing FK target -> warn only', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fk: RawForeignKey = {
      name: 'ghost_fk',
      columns: ['ghost_id'],
      referencedSchema: 'public',
      referencedTable: 'nonexistent',
      referencedColumns: ['id'],
      onDelete: 'NO ACTION',
      onUpdate: 'NO ACTION',
      comment: null,
    };
    const raw = makeRaw({
      tables: [makeTable('a', { columns: [makeCol('ghost_id', 'uuid')], foreignKeys: [fk] })],
    });
    const ctx = await buildSchemaContext({ raw });
    expect(ctx.tables).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/nonexistent/));
  });

  it('strict=true: missing FK target -> KozouBuildError throw', async () => {
    const fk: RawForeignKey = {
      name: 'ghost_fk',
      columns: ['ghost_id'],
      referencedSchema: 'public',
      referencedTable: 'nonexistent',
      referencedColumns: ['id'],
      onDelete: 'NO ACTION',
      onUpdate: 'NO ACTION',
      comment: null,
    };
    const raw = makeRaw({
      tables: [makeTable('a', { columns: [makeCol('ghost_id', 'uuid')], foreignKeys: [fk] })],
    });
    await expect(buildSchemaContext({ raw, strict: true })).rejects.toBeInstanceOf(
      KozouBuildError,
    );
  });

  it('UIHints referencing a missing table -> issue', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const raw = makeRaw({ tables: [makeTable('a')] });
    await buildSchemaContext({
      raw,
      uiHints: { tables: { ghost_table: { label: 'X' } } },
    });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/ghost_table/));
  });

  it('UIHints referencing a missing column -> issue', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const raw = makeRaw({
      tables: [makeTable('a', { columns: [makeCol('id', 'uuid')] })],
    });
    await buildSchemaContext({
      raw,
      uiHints: { tables: { a: { columns: { ghost_col: { label: 'X' } } } } },
    });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/ghost_col/));
  });

  it('UIHints displayField that does not exist -> issue + heuristic fallback', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const raw = makeRaw({
      tables: [
        makeTable('a', {
          columns: [makeCol('id', 'uuid'), makeCol('name', 'text')],
          primaryKey: ['id'],
        }),
      ],
    });
    const ctx = await buildSchemaContext({
      raw,
      uiHints: { tables: { a: { displayField: 'ghost' } } },
    });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/ghost/));
    expect(ctx.tables[0]!.displayField).toBe('name');
  });

  it('VIEW concepts generated 1:1 with views, aiNotes from @ai tags', async () => {
    const view: RawView = {
      schema: 'public',
      name: 'vw_sample',
      comment: 'Sales listing.\n@ai: start from this VIEW\n@ai: recommended for aggregations',
      columns: [makeCol('id', 'uuid')],
      underlyingTables: [{ schema: 'public', name: 'orders' }],
      definition: 'SELECT 1',
    };
    const raw = makeRaw({ views: [view] });
    const ctx = await buildSchemaContext({ raw });
    expect(ctx.concepts).toHaveLength(1);
    expect(ctx.concepts[0]!.aiNotes).toEqual([
      'start from this VIEW',
      'recommended for aggregations',
    ]);
    expect(ctx.concepts[0]!.joinSuggestions).toEqual([
      { table: 'public.orders', on: 'vw_sample.<fk_column> = orders.<pk_column>' },
    ]);
    expect(ctx.concepts[0]!.exampleQueries).toEqual([]);
  });

  it('VIEW concepts surface @example: blocks as exampleQueries', async () => {
    const view: RawView = {
      schema: 'public',
      name: 'vw_sales_by_artist',
      comment:
        'Aggregated sales.\n' +
        '@example: Totals by artist for the current month\n' +
        '  SELECT artist_id, SUM(amount)\n' +
        '  FROM vw_sales_by_artist\n' +
        '  GROUP BY artist_id;',
      columns: [],
      underlyingTables: [],
      definition: 'SELECT 1',
    };
    const raw = makeRaw({ views: [view] });
    const ctx = await buildSchemaContext({ raw });
    expect(ctx.concepts).toHaveLength(1);
    expect(ctx.concepts[0]!.exampleQueries).toEqual([
      {
        description: 'Totals by artist for the current month',
        sql:
          'SELECT artist_id, SUM(amount)\n' +
          'FROM vw_sales_by_artist\n' +
          'GROUP BY artist_id;',
      },
    ]);
  });

  it('threads @policy: into table / column / view / concept', async () => {
    const table = makeTable('orders', {
      comment: 'Order records.\n@policy: status may not change in production',
      columns: [
        makeCol('id', 'uuid'),
        makeCol('status', 'text', {
          comment: 'Order status.\n@policy: only support may set it to refunded',
        }),
      ],
      primaryKey: ['id'],
    });
    const view: RawView = {
      schema: 'public',
      name: 'vw_orders',
      comment: 'Order listing.\n@policy: internal use only',
      columns: [makeCol('id', 'uuid')],
      underlyingTables: [{ schema: 'public', name: 'orders' }],
      definition: 'SELECT 1',
    };
    const raw = makeRaw({ tables: [table], views: [view] });
    const ctx = await buildSchemaContext({ raw });

    const t = ctx.tables[0]!;
    expect(t.policy).toEqual(['status may not change in production']);
    expect(t.columns.find((c) => c.name === 'status')!.policy).toEqual([
      'only support may set it to refunded',
    ]);
    // A column with no @policy: gets an empty array, not undefined.
    expect(t.columns.find((c) => c.name === 'id')!.policy).toEqual([]);

    expect(ctx.views[0]!.policy).toEqual(['internal use only']);
    expect(ctx.concepts[0]!.policies).toEqual(['internal use only']);
  });

  it('VIEW.label / description / purpose extraction', async () => {
    const view: RawView = {
      schema: 'public',
      name: 'vw_sample',
      comment: 'Sales listing.\nSecond paragraph.',
      columns: [],
      underlyingTables: [],
      definition: 'SELECT 1',
    };
    const raw = makeRaw({ views: [view] });
    const ctx = await buildSchemaContext({
      raw,
      uiHints: { views: { vw_sample: { label: 'Sales view' } } },
    });
    const v = ctx.views[0]!;
    expect(v.label).toBe('Sales view');
    expect(v.description).toContain('Sales listing.');
    expect(v.purpose).toContain('Sales listing.');
  });

  it('UIHints view label overrides', async () => {
    const view: RawView = {
      schema: 'public',
      name: 'vw_x',
      comment: null,
      columns: [],
      underlyingTables: [],
      definition: 'SELECT 1',
    };
    const raw = makeRaw({ views: [view] });
    const ctx = await buildSchemaContext({
      raw,
      uiHints: { views: { vw_x: { label: 'X view' } } },
    });
    expect(ctx.views[0]!.label).toBe('X view');
  });

  it('TABLE.label is the table name, never the COMMENT (kept symmetric with views)', async () => {
    // Regression: a commented table used to derive its label from the COMMENT's
    // first line, so the dashboard rendered the comment twice (title +
    // description) and hid the table name. The label must be the bare name; the
    // COMMENT only surfaces as description — exactly how the VIEW path behaves.
    const raw = makeRaw({
      tables: [
        makeTable('example_table', {
          comment: 'A short description of the table.',
          columns: [makeCol('id', 'uuid')],
          primaryKey: ['id'],
        }),
      ],
      views: [
        {
          schema: 'public',
          name: 'example_view',
          comment: 'A short description of the view.',
          columns: [],
          underlyingTables: [],
          definition: 'SELECT 1',
        },
      ],
    });
    const ctx = await buildSchemaContext({ raw });

    const table = ctx.tables[0]!;
    expect(table.label).toBe('example_table');
    expect(table.description).toBe('A short description of the table.');
    expect(table.label).not.toBe(table.description);

    // The view path has always behaved this way; assert both stay symmetric.
    const view = ctx.views[0]!;
    expect(view.label).toBe('example_view');
    expect(view.description).toBe('A short description of the view.');
  });
});

describe('buildSchemaContext privilege-aware (#99)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const role = 'app_user';

  it('exposes insertable/updatable as the privilege truth; readonly stays hint-sourced (mode-aware lives in the UI)', async () => {
    const raw = makeRaw({
      tables: [
        makeTable('orders', {
          privileges: { role, select: true, insert: true, update: true, delete: false },
          columns: [
            // insertable, not updatable (write-once) — editable on create, locked on edit.
            makeCol('created_by', 'uuid', { privileges: { insert: true, update: false } }),
            // updatable, not insertable — locked on create, editable on edit.
            makeCol('reviewed_at', 'timestamptz', { privileges: { insert: false, update: true } }),
            makeCol('note', 'text', { privileges: { insert: true, update: true } }),
          ],
        }),
      ],
    });
    const ctx = await buildSchemaContext({ raw });
    const cols = new Map(ctx.tables[0]!.columns.map((c) => [c.name, c]));
    // readonly is NOT derived from privileges here (mode-dependent → UI layer).
    expect(cols.get('created_by')!.readonly).toBe(false);
    expect(cols.get('created_by')!.insertable).toBe(true);
    expect(cols.get('created_by')!.updatable).toBe(false);
    expect(cols.get('reviewed_at')!.insertable).toBe(false);
    expect(cols.get('reviewed_at')!.updatable).toBe(true);
    expect(cols.get('note')!.insertable).toBe(true);
    expect(cols.get('note')!.updatable).toBe(true);
  });

  it('a hint readonly:true is preserved alongside the privilege truth', async () => {
    const raw = makeRaw({
      tables: [
        makeTable('orders', {
          privileges: { role, select: true, insert: true, update: true, delete: true },
          columns: [makeCol('locked', 'text', { privileges: { insert: true, update: true } })],
        }),
      ],
    });
    const ctx = await buildSchemaContext({
      raw,
      uiHints: { tables: { orders: { columns: { locked: { readonly: true } } } } },
    });
    expect(ctx.tables[0]!.columns[0]!.readonly).toBe(true);
    expect(ctx.tables[0]!.columns[0]!.updatable).toBe(true);
  });

  it('a table the role cannot SELECT is hidden, with a warning (other tables kept)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const raw = makeRaw({
      tables: [
        makeTable('secrets', {
          privileges: { role, select: false, insert: false, update: false, delete: false },
          columns: [makeCol('id', 'uuid', { privileges: { insert: false, update: false } })],
        }),
        makeTable('orders', {
          privileges: { role, select: true, insert: true, update: true, delete: true },
          columns: [makeCol('id', 'uuid', { privileges: { insert: true, update: true } })],
        }),
      ],
    });
    const ctx = await buildSchemaContext({ raw });
    expect(ctx.tables.map((t) => t.name)).toEqual(['orders']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('secrets'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(role));
  });

  it('a view the role cannot SELECT is hidden from views and concepts', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mkView = (name: string, select: boolean) => ({
      schema: 'public',
      name,
      comment: 'a concept',
      columns: [],
      underlyingTables: [],
      definition: 'SELECT 1',
      privileges: { role, select, insert: false, update: false, delete: false },
    });
    const raw = makeRaw({
      views: [mkView('vw_secret', false), mkView('vw_public', true)],
    });
    const ctx = await buildSchemaContext({ raw });
    expect(ctx.views.map((v) => v.name)).toEqual(['vw_public']);
    expect(ctx.concepts.map((c) => c.name)).toEqual(['vw_public']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('vw_secret'));
  });

  it('default (no privileges evaluated) leaves tables/columns schema-faithful', async () => {
    const raw = makeRaw({
      tables: [
        makeTable('orders', {
          columns: [makeCol('status', 'text')],
        }),
      ],
    });
    const ctx = await buildSchemaContext({ raw });
    const col = ctx.tables[0]!.columns[0]!;
    expect(ctx.tables.map((t) => t.name)).toEqual(['orders']);
    expect(col.readonly).toBe(false);
    expect(col.insertable).toBeUndefined();
    expect(col.updatable).toBeUndefined();
  });

  it('filter mode (default) carries the survivors’ privileges onto the context', async () => {
    const raw = makeRaw({
      tables: [
        makeTable('orders', {
          privileges: { role, select: true, insert: false, update: false, delete: false },
          columns: [makeCol('id', 'uuid', { privileges: { insert: false, update: false } })],
        }),
      ],
    });
    const ctx = await buildSchemaContext({ raw });
    expect(ctx.tables[0]!.privileges).toEqual({
      role,
      select: true,
      insert: false,
      update: false,
      delete: false,
    });
  });

  it('annotate mode keeps a table the role cannot SELECT and surfaces its privileges', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const raw = makeRaw({
      tables: [
        makeTable('secrets', {
          privileges: { role, select: false, insert: false, update: false, delete: false },
          columns: [makeCol('id', 'uuid', { privileges: { insert: false, update: false } })],
        }),
        makeTable('orders', {
          privileges: { role, select: true, insert: false, update: false, delete: false },
          columns: [makeCol('id', 'uuid', { privileges: { insert: false, update: false } })],
        }),
      ],
    });
    const ctx = await buildSchemaContext({ raw, privilegeDisplay: 'annotate' });
    // Nothing hidden: the agent still sees the unreadable relation, labelled.
    expect(ctx.tables.map((t) => t.name).sort()).toEqual(['orders', 'secrets']);
    expect(ctx.tables.find((t) => t.name === 'secrets')!.privileges).toEqual({
      role,
      select: false,
      insert: false,
      update: false,
      delete: false,
    });
    expect(ctx.tables.find((t) => t.name === 'orders')!.columns[0]!.insertable).toBe(false);
    // No "hid N relation(s)" warning in annotate mode.
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('hid '));
  });

  it('annotate mode keeps a view the role cannot SELECT and surfaces its privileges', async () => {
    const mkView = (name: string, select: boolean) => ({
      schema: 'public',
      name,
      comment: 'a concept',
      columns: [],
      underlyingTables: [],
      definition: 'SELECT 1',
      privileges: { role, select, insert: false, update: false, delete: false },
    });
    const raw = makeRaw({ views: [mkView('vw_secret', false), mkView('vw_public', true)] });
    const ctx = await buildSchemaContext({ raw, privilegeDisplay: 'annotate' });
    expect(ctx.views.map((v) => v.name).sort()).toEqual(['vw_public', 'vw_secret']);
    expect(ctx.views.find((v) => v.name === 'vw_secret')!.privileges).toEqual({
      role,
      select: false,
      insert: false,
      update: false,
      delete: false,
    });
    // Concepts mirror views in annotate mode too (nothing hidden).
    expect(ctx.concepts.map((c) => c.name).sort()).toEqual(['vw_public', 'vw_secret']);
  });

  it('annotate mode is a no-op when privileges were not evaluated (privileges omitted)', async () => {
    const raw = makeRaw({
      tables: [makeTable('orders', { columns: [makeCol('status', 'text')] })],
    });
    const ctx = await buildSchemaContext({ raw, privilegeDisplay: 'annotate' });
    expect(ctx.tables[0]!.privileges).toBeUndefined();
    expect(ctx.tables[0]!.columns[0]!.insertable).toBeUndefined();
  });

  describe('row-level security signal', () => {
    it('passes rowSecurity from the raw table through to the context', async () => {
      const raw = makeRaw({
        tables: [
          makeTable('orders', {
            rowSecurity: { enabled: true, forced: false, hasPolicies: true },
          }),
        ],
      });
      const ctx = await buildSchemaContext({ raw });
      expect(ctx.tables[0]!.rowSecurity).toEqual({
        enabled: true,
        forced: false,
        hasPolicies: true,
      });
    });

    it('omits rowSecurity when the raw table lacks it (older context)', async () => {
      const raw = makeRaw({ tables: [makeTable('orders')] });
      const ctx = await buildSchemaContext({ raw });
      expect(ctx.tables[0]!.rowSecurity).toBeUndefined();
    });

    it('never sets rowSecurity on a view (tables only)', async () => {
      const raw = makeRaw({
        views: [
          {
            schema: 'public',
            name: 'vw_orders',
            comment: null,
            columns: [],
            underlyingTables: [],
            definition: 'SELECT 1',
          },
        ],
      });
      const ctx = await buildSchemaContext({ raw });
      expect('rowSecurity' in ctx.views[0]!).toBe(false);
    });
  });
});
