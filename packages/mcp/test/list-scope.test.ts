// list_tables / list_views surface the introspection scope (issue #178): an
// empty `tables`/`views` for a schema that was never introspected (outOfScope)
// is now distinguishable from an in-scope schema that genuinely has none.
// Driven off an in-memory SchemaContext — no database needed.

import { describe, expect, it } from 'vitest';
import { buildSchemaContext, type RawIntrospection, type SchemaContext } from '@kozou/core';
import { listTables, listViews } from '../src/index.js';

// Two introspected schemas: `public` has a table + a view, `reporting` has
// neither. `audit` is NOT introspected.
const RAW: RawIntrospection = {
  serverVersion: '16.2',
  introspectedAt: '2026-01-01T00:00:00.000Z',
  schemas: ['public', 'reporting'],
  enums: [],
  functions: [],
  tables: [
    {
      schema: 'public',
      name: 'widgets',
      comment: null,
      primaryKey: ['id'],
      foreignKeys: [],
      checks: [],
      indexes: [],
      rowCountEstimate: null,
      columns: [
        {
          name: 'id',
          dataType: 'uuid',
          udtName: 'uuid',
          nullable: false,
          defaultExpr: null,
          comment: null,
          position: 1,
        },
      ],
    },
  ],
  views: [
    {
      schema: 'public',
      name: 'vw_widgets',
      comment: null,
      columns: [],
      underlyingTables: [{ schema: 'public', name: 'widgets' }],
      definition: 'SELECT 1',
    },
  ],
};

let ctx: SchemaContext;
async function context(): Promise<SchemaContext> {
  ctx ??= await buildSchemaContext({ raw: RAW });
  return ctx;
}

describe('list_tables introspection scope (#178)', () => {
  it('reports sourceSchemas and lists tables for an in-scope schema', async () => {
    const r = listTables({ schema: 'public' }, await context());
    expect(r.sourceSchemas).toEqual(['public', 'reporting']);
    expect(r.outOfScope).toBe(false);
    expect(r.tables.map((t) => t.qualifiedName)).toEqual(['public.widgets']);
  });

  it('an in-scope schema with no tables is not out of scope', async () => {
    const r = listTables({ schema: 'reporting' }, await context());
    expect(r.outOfScope).toBe(false);
    expect(r.tables).toEqual([]);
  });

  it('a schema outside the introspected set is flagged out of scope', async () => {
    const r = listTables({ schema: 'audit' }, await context());
    expect(r.outOfScope).toBe(true);
    expect(r.tables).toEqual([]);
  });
});

describe('list_views introspection scope (#178)', () => {
  it('reports sourceSchemas and lists views for an in-scope schema', async () => {
    const r = listViews({ schema: 'public' }, await context());
    expect(r.sourceSchemas).toEqual(['public', 'reporting']);
    expect(r.outOfScope).toBe(false);
    expect(r.views.map((v) => v.qualifiedName)).toEqual(['public.vw_widgets']);
  });

  it('an in-scope schema with no views is not out of scope', async () => {
    const r = listViews({ schema: 'reporting' }, await context());
    expect(r.outOfScope).toBe(false);
    expect(r.views).toEqual([]);
  });

  it('a schema outside the introspected set is flagged out of scope', async () => {
    const r = listViews({ schema: 'audit' }, await context());
    expect(r.outOfScope).toBe(true);
    expect(r.views).toEqual([]);
  });
});
