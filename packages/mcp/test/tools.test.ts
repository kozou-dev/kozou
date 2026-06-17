import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pkg from 'pg';
import { buildSchemaContext, type RawIntrospection } from '@kozou/core';
import {
  setupDatabase,
  type DatabaseHandle,
  GENERIC_FIXTURE_SQL,
} from '@kozou/test-utils';
import {
  SchemaCache,
  listTables,
  describeTable,
  listViews,
  describeView,
  listConcepts,
  getConceptContext,
} from '../src/index.js';

describe('MCP tools (generic English fixture)', () => {
  let db: DatabaseHandle;
  let cache: SchemaCache;

  beforeAll(async () => {
    db = await setupDatabase();
    const client = new pkg.Client({ connectionString: db.connectionString });
    await client.connect();
    try {
      await client.query(`CREATE SCHEMA "${db.schema}"`);
      await client.query(`SET search_path TO "${db.schema}"`);
      await client.query(GENERIC_FIXTURE_SQL);
    } finally {
      await client.end();
    }
    cache = new SchemaCache({
      connection: db.connectionString,
      schemas: [db.schema],
      ttlMs: 60_000,
    });
  }, 120_000);

  afterAll(async () => {
    if (db) await db.cleanup();
  });

  it('list_tables: returns 4 tables', async () => {
    const ctx = await cache.get();
    const r = listTables({ schema: db.schema }, ctx);
    expect(r.tables.map((t) => t.qualifiedName).sort()).toEqual([
      `${db.schema}.authors`,
      `${db.schema}.books`,
      `${db.schema}.editions`,
      `${db.schema}.inventory_items`,
    ]);
    // rowCountEstimate is either null (never analyzed) or a non-negative
    // integer. The cache fixture inserts no rows and does not run
    // ANALYZE, so PostgreSQL may leave reltuples at -1 (mapped to null)
    // or autovacuum may bump it to 0 between fixture load and the
    // introspect query. The dedicated `reflects analyzed table
    // cardinality` test below covers the analyzed-with-rows path.
    for (const t of r.tables) {
      expect(t.rowCountEstimate === null || t.rowCountEstimate >= 0).toBe(true);
    }
  });

  it('list_tables: rowCountEstimate reflects analyzed table cardinality', async () => {
    const client = new pkg.Client({ connectionString: db.connectionString });
    await client.connect();
    try {
      await client.query(`SET search_path TO "${db.schema}"`);
      await client.query(
        `INSERT INTO authors (display_name) VALUES ('A'), ('B'), ('C')`,
      );
      await client.query(`ANALYZE "${db.schema}".authors`);
    } finally {
      await client.end();
    }

    // Fresh cache so the next introspect call re-runs against the now-
    // analyzed table.
    const freshCache = new SchemaCache({
      connection: db.connectionString,
      schemas: [db.schema],
      ttlMs: 60_000,
    });
    const ctx = await freshCache.get();
    const r = listTables({ schema: db.schema }, ctx);

    const authors = r.tables.find(
      (t) => t.qualifiedName === `${db.schema}.authors`,
    );
    expect(authors).toBeDefined();
    expect(typeof authors!.rowCountEstimate).toBe('number');
    expect(authors!.rowCountEstimate).toBeGreaterThanOrEqual(3);
  });

  it('list_tables: empty when targeting a different schema', async () => {
    const ctx = await cache.get();
    const r = listTables({ schema: 'public' }, ctx);
    expect(r.tables).toEqual([]);
  });

  it('list_tables: defaults to the public schema when no schema arg is given', async () => {
    // Exercises the `schema ?? "public"` default: the fixture lives under
    // the test schema, so the public default yields no matches.
    const ctx = await cache.get();
    const r = listTables({}, ctx);
    expect(r.tables).toEqual([]);
  });

  it('describe_table: inventory_items columns + checkConstraints + references', async () => {
    const ctx = await cache.get();
    const r = describeTable({ qualifiedName: `${db.schema}.inventory_items` }, ctx);
    expect(r.primaryKey).toEqual(['id']);
    const status = r.columns.find((c) => c.name === 'status');
    expect(status).toBeDefined();
    expect(status!.enumValues?.sort()).toEqual(['for_sale', 'reserved', 'sold']);
    const editionId = r.columns.find((c) => c.name === 'edition_id');
    expect(editionId!.isForeignKey).toBe(true);
    expect(editionId!.references).toEqual({
      table: `${db.schema}.editions`,
      column: 'id',
    });
    expect(r.checkConstraints.length).toBeGreaterThan(0);
    expect(r.checkConstraints.some((c) => /for_sale/.test(c.expression))).toBe(true);
  });

  it('describe_table: throws for unknown table', async () => {
    const ctx = await cache.get();
    expect(() =>
      describeTable({ qualifiedName: `${db.schema}.nonexistent` }, ctx),
    ).toThrow(/Table not found/);
  });

  it('list_views: returns 1 view', async () => {
    const ctx = await cache.get();
    const r = listViews({ schema: db.schema }, ctx);
    expect(r.views.map((v) => v.qualifiedName).sort()).toEqual([
      `${db.schema}.vw_inventory_for_sale`,
    ]);
  });

  it('list_views: defaults to the public schema when no schema arg is given', async () => {
    // Exercises the `schema ?? "public"` default (see list_tables above).
    const ctx = await cache.get();
    const r = listViews({}, ctx);
    expect(r.views).toEqual([]);
  });

  it('describe_view: vw_inventory_for_sale underlyingTables + definition', async () => {
    const ctx = await cache.get();
    const r = describeView({ qualifiedName: `${db.schema}.vw_inventory_for_sale` }, ctx);
    expect(r.underlyingTables.sort()).toEqual([
      `${db.schema}.authors`,
      `${db.schema}.books`,
      `${db.schema}.editions`,
      `${db.schema}.inventory_items`,
    ]);
    expect(r.definition).toMatch(/SELECT/i);
    expect(r.definition).toMatch(/inventory_items/);
  });

  it('describe_view: throws for unknown view', async () => {
    const ctx = await cache.get();
    expect(() =>
      describeView({ qualifiedName: `${db.schema}.nonexistent` }, ctx),
    ).toThrow(/View not found/);
  });

  it('list_concepts: returns 1 concept with kind = VIEW', async () => {
    const ctx = await cache.get();
    const r = listConcepts({}, ctx);
    expect(r.concepts).toHaveLength(1);
    expect(r.concepts.every((c) => c.kind === 'VIEW')).toBe(true);
  });

  it('get_concept_context: vw_inventory_for_sale aiNotes / preferredQuerySource / relatedTables', async () => {
    const ctx = await cache.get();
    const r = getConceptContext({ name: 'vw_inventory_for_sale' }, ctx);
    expect(r.name).toBe('vw_inventory_for_sale');
    expect(r.preferredQuerySource).toBe('FROM vw_inventory_for_sale');
    expect(r.aiNotes.length).toBeGreaterThan(0);
    expect(r.relatedTables.length).toBe(4);
  });

  it('get_concept_context: exampleQueries surfaces the @example: block on the VIEW comment', async () => {
    const ctx = await cache.get();
    const r = getConceptContext({ name: 'vw_inventory_for_sale' }, ctx);
    expect(r.exampleQueries).toEqual([
      {
        description: 'Items currently for sale, by author',
        sql:
          'SELECT author_name, book_title, selling_price\n' +
          'FROM vw_inventory_for_sale\n' +
          'ORDER BY author_name, book_title;',
      },
    ]);
  });

  it('get_concept_context: throws for unknown concept', async () => {
    const ctx = await cache.get();
    expect(() => getConceptContext({ name: 'nonexistent' }, ctx)).toThrow(
      /Concept not found/,
    );
  });

  // docs/security.md threat-model fixed test: COMMENT-derived strings are
  // included verbatim in MCP output (trust boundary). The schema author is
  // treated as inside the v0.1 trust boundary; this test catches regressions
  // if a future change starts sanitising the @ai tag output.
  it('threat model: @ai tag content appears verbatim in aiDescription / aiNotes', async () => {
    const ctx = await cache.get();

    const inv = describeTable({ qualifiedName: `${db.schema}.inventory_items` }, ctx);
    expect(inv.aiDescription).toMatch(/prefer vw_inventory_for_sale/);

    const concept = getConceptContext({ name: 'vw_inventory_for_sale' }, ctx);
    expect(concept.aiNotes.some((n) => /start from this VIEW/i.test(n))).toBe(true);
  });
});

describe('MCP tools: @policy is surfaced to the AI agent (no DB)', () => {
  // buildSchemaContext is pure, so this needs no container. `@policy:` tags
  // are advisory business rules for the agent (never enforced by kozou — hard
  // access control is the schema author's Postgres row-level security). These
  // tests prove the tags flow through to the tool output, including the
  // empty-array case for an object that carries none.
  const raw: RawIntrospection = {
    serverVersion: '16.2',
    introspectedAt: '2026-01-01T00:00:00.000Z',
    schemas: ['public'],
    enums: [],
    functions: [],
    tables: [
      {
        schema: 'public',
        name: 'orders',
        comment: 'Order records.\n@policy: status may not change in production',
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
          {
            name: 'status',
            dataType: 'text',
            udtName: 'text',
            nullable: false,
            defaultExpr: null,
            comment: 'Order status.\n@policy: only support may set it to refunded',
            position: 2,
          },
        ],
      },
    ],
    views: [
      {
        schema: 'public',
        name: 'vw_orders',
        comment: 'Order listing.\n@policy: internal use only',
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
        underlyingTables: [{ schema: 'public', name: 'orders' }],
        definition: 'SELECT id FROM orders',
      },
    ],
  };

  it('describe_table surfaces table- and column-level @policy', async () => {
    const ctx = await buildSchemaContext({ raw });
    const r = describeTable({ qualifiedName: 'public.orders' }, ctx);
    expect(r.policy).toEqual(['status may not change in production']);
    expect(r.columns.find((c) => c.name === 'status')!.policy).toEqual([
      'only support may set it to refunded',
    ]);
    // A column with no @policy: surfaces an empty array.
    expect(r.columns.find((c) => c.name === 'id')!.policy).toEqual([]);
  });

  it('describe_view surfaces view-level @policy', async () => {
    const ctx = await buildSchemaContext({ raw });
    const r = describeView({ qualifiedName: 'public.vw_orders' }, ctx);
    expect(r.policy).toEqual(['internal use only']);
  });

  it('get_concept_context surfaces the VIEW @policy as policies', async () => {
    const ctx = await buildSchemaContext({ raw });
    const r = getConceptContext({ name: 'vw_orders' }, ctx);
    expect(r.policies).toEqual(['internal use only']);
  });

  it('tolerates a context built before the policy field existed', async () => {
    const ctx = await buildSchemaContext({ raw });
    // `policy` is optional on the context types, so a context produced by an
    // older @kozou/core may omit it entirely. Strip it and confirm the tools
    // fall back to empty arrays rather than emitting `undefined`.
    type MaybePolicy = { policy?: string[]; policies?: string[] };
    for (const t of ctx.tables) {
      delete (t as MaybePolicy).policy;
      for (const c of t.columns) delete (c as MaybePolicy).policy;
    }
    for (const v of ctx.views) {
      delete (v as MaybePolicy).policy;
      for (const c of v.columns) delete (c as MaybePolicy).policy;
    }
    for (const c of ctx.concepts) delete (c as MaybePolicy).policies;

    expect(describeTable({ qualifiedName: 'public.orders' }, ctx).policy).toEqual([]);
    expect(describeView({ qualifiedName: 'public.vw_orders' }, ctx).policy).toEqual([]);
    expect(getConceptContext({ name: 'vw_orders' }, ctx).policies).toEqual([]);
  });

  it('describe_table / describe_view annotate privileges in privilege-aware mode', async () => {
    const role = 'analyst';
    const privRaw = {
      ...raw,
      tables: [
        {
          ...raw.tables[0]!,
          privileges: { role, select: true, insert: false, update: false, delete: false },
          columns: raw.tables[0]!.columns.map((c) => ({
            ...c,
            privileges: { insert: false, update: false },
          })),
        },
      ],
      views: [
        {
          ...raw.views[0]!,
          privileges: { role, select: true, insert: false, update: false, delete: false },
        },
      ],
    };
    const ctx = await buildSchemaContext({ raw: privRaw, privilegeDisplay: 'annotate' });

    const t = describeTable({ qualifiedName: 'public.orders' }, ctx);
    expect(t.privileges).toEqual({
      role,
      select: true,
      insert: false,
      update: false,
      delete: false,
    });
    const status = t.columns.find((c) => c.name === 'status')!;
    expect(status.insertable).toBe(false);
    expect(status.updatable).toBe(false);

    const v = describeView({ qualifiedName: 'public.vw_orders' }, ctx);
    expect(v.privileges).toEqual({
      role,
      select: true,
      insert: false,
      update: false,
      delete: false,
    });
  });

  it('describe_table omits privileges in schema-wide mode (default)', async () => {
    const ctx = await buildSchemaContext({ raw });
    const t = describeTable({ qualifiedName: 'public.orders' }, ctx);
    expect(t.privileges).toBeUndefined();
    expect(t.columns.find((c) => c.name === 'status')!.insertable).toBeUndefined();
  });

  // Row-level security signal. Surfaced unconditionally
  // (unlike the opt-in privilege mode): a boolean + advisory note, never the
  // policy expressions.
  const withRls = (rowSecurity: {
    enabled: boolean;
    forced: boolean;
    hasPolicies: boolean;
  }): RawIntrospection => ({
    ...raw,
    tables: [{ ...raw.tables[0]!, rowSecurity }],
  });

  it('describe_table surfaces rowSecurity with an advisory note when RLS is on', async () => {
    const ctx = await buildSchemaContext({
      raw: withRls({ enabled: true, forced: false, hasPolicies: true }),
    });
    const t = describeTable({ qualifiedName: 'public.orders' }, ctx);
    expect(t.rowSecurity).toMatchObject({ enabled: true, forced: false, hasPolicies: true });
    expect(t.rowSecurity!.note).toMatch(/row-level security is enabled/i);
    expect(t.rowSecurity!.note).toMatch(/do not assume a result is complete/i);
  });

  it('describe_table flags default-deny when RLS is on but no policy exists', async () => {
    const ctx = await buildSchemaContext({
      raw: withRls({ enabled: true, forced: false, hasPolicies: false }),
    });
    const t = describeTable({ qualifiedName: 'public.orders' }, ctx);
    expect(t.rowSecurity).toMatchObject({ enabled: true, hasPolicies: false });
    expect(t.rowSecurity!.note).toMatch(/default-deny/i);
  });

  it('describe_table notes forced RLS (applies to the owner too)', async () => {
    const ctx = await buildSchemaContext({
      raw: withRls({ enabled: true, forced: true, hasPolicies: true }),
    });
    const t = describeTable({ qualifiedName: 'public.orders' }, ctx);
    expect(t.rowSecurity!.forced).toBe(true);
    expect(t.rowSecurity!.note).toMatch(/owner/i);
  });

  it('describe_table surfaces rowSecurity (no note) when RLS is off', async () => {
    const ctx = await buildSchemaContext({
      raw: withRls({ enabled: false, forced: false, hasPolicies: false }),
    });
    const t = describeTable({ qualifiedName: 'public.orders' }, ctx);
    expect(t.rowSecurity).toEqual({ enabled: false, forced: false, hasPolicies: false });
    expect(t.rowSecurity!.note).toBeUndefined();
  });

  it('describe_table never leaks a policy expression', async () => {
    // The fixture has no expression to leak, but assert the surface shape never
    // grows an expression-bearing field even when RLS is fully on.
    const ctx = await buildSchemaContext({
      raw: withRls({ enabled: true, forced: true, hasPolicies: true }),
    });
    const t = describeTable({ qualifiedName: 'public.orders' }, ctx);
    expect(Object.keys(t.rowSecurity!).sort()).toEqual(
      ['enabled', 'forced', 'hasPolicies', 'note'].sort(),
    );
  });

  it('describe_table omits rowSecurity for a context built before the field existed', async () => {
    const ctx = await buildSchemaContext({ raw });
    type MaybeRls = { rowSecurity?: unknown };
    for (const t of ctx.tables) delete (t as MaybeRls).rowSecurity;
    const t = describeTable({ qualifiedName: 'public.orders' }, ctx);
    expect(t.rowSecurity).toBeUndefined();
  });
});
