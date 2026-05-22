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

  it('基本構造 (tables/views/enums/concepts カウント)', async () => {
    const raw = makeRaw({
      tables: [makeTable('artists'), makeTable('artworks')],
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
    expect(ctx.tables.map((t) => t.name)).toEqual(['artists', 'artworks']);
    expect(ctx.views.map((v) => v.name)).toEqual(['vw_for_sale']);
    expect(ctx.enums.map((e) => e.name)).toEqual(['status_enum']);
    expect(ctx.concepts).toHaveLength(1);
    expect(ctx.concepts[0]!.kind).toBe('VIEW');
    expect(ctx.meta.serverVersion).toBe('16.2');
    expect(ctx.meta.sourceSchemas).toEqual(['public']);
  });

  it('widget 推論 priority: UIHints > @widget > heuristic', async () => {
    const col1 = makeCol('status', 'text', { comment: '@widget: enum-select' });
    const col2 = makeCol('display_name', 'text');
    const raw = makeRaw({
      tables: [
        makeTable('artists', {
          columns: [col1, col2],
          primaryKey: ['id'],
        }),
      ],
    });
    const uiHints: UIHints = {
      tables: { artists: { columns: { display_name: { widget: 'currency' } } } },
    };
    const ctx = await buildSchemaContext({ raw, uiHints });
    const cols = ctx.tables[0]!.columns;
    expect(cols.find((c) => c.name === 'status')!.widget).toBe('enum-select');
    expect(cols.find((c) => c.name === 'display_name')!.widget).toBe('currency');
  });

  it('displayField 推論 (UIHints > heuristic)', async () => {
    const raw = makeRaw({
      tables: [
        makeTable('artists', {
          columns: [makeCol('id', 'uuid'), makeCol('display_name', 'text')],
          primaryKey: ['id'],
        }),
      ],
    });
    const noHints = await buildSchemaContext({ raw });
    expect(noHints.tables[0]!.displayField).toBe('display_name');

    const withHints = await buildSchemaContext({
      raw,
      uiHints: { tables: { artists: { displayField: 'id' } } },
    });
    expect(withHints.tables[0]!.displayField).toBe('id');
  });

  it('FK → RelationContext (cardinality many-to-one)', async () => {
    const fk: RawForeignKey = {
      name: 'artworks_artist_id_fkey',
      columns: ['artist_id'],
      referencedSchema: 'public',
      referencedTable: 'artists',
      referencedColumns: ['id'],
      onDelete: 'NO ACTION',
      onUpdate: 'NO ACTION',
      comment: '作家への参照',
    };
    const raw = makeRaw({
      tables: [
        makeTable('artists', { columns: [makeCol('id', 'uuid')], primaryKey: ['id'] }),
        makeTable('artworks', {
          columns: [makeCol('artist_id', 'uuid')],
          primaryKey: ['id'],
          foreignKeys: [fk],
        }),
      ],
    });
    const ctx = await buildSchemaContext({ raw });
    const artworks = ctx.tables.find((t) => t.name === 'artworks')!;
    expect(artworks.relations).toHaveLength(1);
    expect(artworks.relations[0]).toMatchObject({
      field: 'artist_id',
      references: { schema: 'public', table: 'artists', column: 'id' },
      cardinality: 'many-to-one',
      meaning: '作家への参照',
    });
  });

  it('FK + UNIQUE index → cardinality one-to-one', async () => {
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

  it('CHECK → enumValues + widget enum-select', async () => {
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

  it('strict=false: missing FK target → warn のみ', async () => {
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

  it('strict=true: missing FK target → KozouBuildError throw', async () => {
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

  it('UIHints が指す存在しない table → issue', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const raw = makeRaw({ tables: [makeTable('a')] });
    await buildSchemaContext({
      raw,
      uiHints: { tables: { ghost_table: { label: 'X' } } },
    });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/ghost_table/));
  });

  it('UIHints が指す存在しない column → issue', async () => {
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

  it('UIHints の displayField が存在しない → issue + heuristic fallback', async () => {
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

  it('VIEW concepts は VIEW 1:1 で生成、aiNotes は @ai tag', async () => {
    const view: RawView = {
      schema: 'public',
      name: 'vw_sample',
      comment: '販売一覧。\n@ai: 起点 VIEW として使う\n@ai: 集計に推奨',
      columns: [makeCol('id', 'uuid')],
      underlyingTables: [{ schema: 'public', name: 'orders' }],
      definition: 'SELECT 1',
    };
    const raw = makeRaw({ views: [view] });
    const ctx = await buildSchemaContext({ raw });
    expect(ctx.concepts).toHaveLength(1);
    expect(ctx.concepts[0]!.aiNotes).toEqual(['起点 VIEW として使う', '集計に推奨']);
    expect(ctx.concepts[0]!.joinSuggestions).toEqual([
      { table: 'public.orders', on: 'vw_sample.<fk_column> = orders.<pk_column>' },
    ]);
  });

  it('VIEW.label / description / purpose の抽出', async () => {
    const view: RawView = {
      schema: 'public',
      name: 'vw_sample',
      comment: '販売一覧。\n第二段落。',
      columns: [],
      underlyingTables: [],
      definition: 'SELECT 1',
    };
    const raw = makeRaw({ views: [view] });
    const ctx = await buildSchemaContext({
      raw,
      uiHints: { views: { vw_sample: { label: '販売 VIEW' } } },
    });
    const v = ctx.views[0]!;
    expect(v.label).toBe('販売 VIEW');
    expect(v.description).toContain('販売一覧。');
    expect(v.purpose).toContain('販売一覧。');
  });

  it('UIHints の view label のみで上書き', async () => {
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
