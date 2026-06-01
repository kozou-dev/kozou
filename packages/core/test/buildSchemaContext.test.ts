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
});
