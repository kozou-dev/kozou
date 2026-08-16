import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import pkg from 'pg';
import { introspect } from '@kozou/introspect';
import { buildSchemaContext, type SchemaContext } from '@kozou/core';
import {
  listTables,
  describeTable,
  listViews,
  describeView,
  listConcepts,
  getConceptContext,
  describeFunctions,
  searchSchema,
} from '@kozou/mcp';
import { buildOpenApiDocument } from '@kozou/api';
import { setupDatabase, type DatabaseHandle } from '@kozou/test-utils';
import { emitMarkdown } from '../src/docs.js';

// README states it without hedging: kozou reads whether a row-security policy
// exists, never the policy expressions, so the authorization model stays in the
// database and out of an agent's context. Until this test, nothing failed if
// that stopped being true.
//
// The property under test is about outputs, not about a code path: a string
// that exists only inside a policy body must not appear in anything kozou
// emits. Every surface swept below is derived from one compiled SchemaContext,
// so a surface added on top of that context is covered by this test as it
// stands, rather than by one somebody remembers to extend.
//
// What it does not cover, stated because the boundary is easy to overstate: a
// surface fed by its own database read. One such read already exists —
// @kozou/api issues `EXPLAIN (FORMAT JSON)` behind `?count=estimated`, and a
// plan taken as a role that RLS applies to carries the policy expression in
// its `Filter`. Nothing emits it (the estimator reads `Plan Rows` and nothing
// else), and this test could not see it if something did: the fixture connects
// as the table's owner, for whom RLS is bypassed.
//
// A companion test in @kozou/introspect covers the half a canary cannot see —
// a value fetched and then dropped leaves no trace in an output — by asserting
// the introspection SQL never names `polqual` / `polwithcheck` / `pg_policies`.
//
// The canary lives in a string literal rather than in a SQL comment: PostgreSQL
// normalizes an expression when it stores it, and a comment does not survive
// that round trip. The positive control below is what pins this down — it reads
// the stored expression back and fails if the canary is not in it, so "absent
// from every surface" can never be true merely because the fixture was wrong.
//
// One thing to know before trusting a local run: this package resolves its
// `@kozou/*` imports to the other packages' BUILT output, so an unbuilt change
// to introspection is invisible here — measured, by making introspect surface a
// policy expression and watching this file stay green until `pnpm -r run build`
// had run. CI builds before it tests, so the order only bites locally.
const CANARY = 'KOZOU_CANARY_POLICY_BODY';

// The same canary as PostgreSQL writes it inside a stored expression tree.
// `pg_node_tree` renders a string constant as a decimal byte list, so a whole
// -row read of `pg_policy` (`SELECT *`, `to_jsonb(p)`, `polqual::text`) carries
// the expression in a form no ASCII search would find — and such a read names
// none of the tokens the companion source assertion forbids, so both guards
// would be green while the expression sat in every payload. Measured on
// PostgreSQL 16: `[ 136 0 0 0 75 79 90 79 85 ... ]`, where `75 79 90 79 85` is
// `KOZOU`. The positive control below fails if that encoding ever stops
// holding, so this pattern can never quietly become one that matches nothing.
const CANARY_BYTES = Array.from(Buffer.from(CANARY, 'utf8')).join(' ');

const FIXTURE_SQL = `
  CREATE TABLE orders (
    id uuid PRIMARY KEY,
    tenant text NOT NULL,
    amount numeric NOT NULL DEFAULT 0
  );
  COMMENT ON TABLE orders IS 'Customer orders.';
  ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
  CREATE POLICY tenant_isolation ON orders
    USING (tenant = '${CANARY}_using')
    WITH CHECK (tenant = '${CANARY}_check');

  CREATE VIEW recent_orders AS SELECT id, tenant, amount FROM orders;
  COMMENT ON VIEW recent_orders IS 'Orders as the application shows them.';

  -- Present so the function surface has something to describe: a sweep over an
  -- empty payload proves nothing. Untagged functions are absent from the
  -- context by design, hence the explicit @expose (with "public", because
  -- CREATE FUNCTION grants PUBLIC EXECUTE and that is otherwise a hard skip).
  CREATE FUNCTION order_total(order_id uuid) RETURNS numeric
    LANGUAGE sql STABLE AS $$ SELECT amount FROM orders WHERE id = order_id $$;
  COMMENT ON FUNCTION order_total(uuid) IS 'Total for one order.
@expose: rpc public';
`;

describe('policy expressions never leave the database', () => {
  let db: DatabaseHandle;
  let ctx: SchemaContext;
  let storedPolicy: {
    using_expr: string | null;
    check_expr: string | null;
    node_tree: string | null;
  };

  beforeAll(async () => {
    db = await setupDatabase();
    const client = new pkg.Client({ connectionString: db.connectionString });
    await client.connect();
    try {
      await client.query(`CREATE SCHEMA "${db.schema}"`);
      await client.query(`SET search_path TO "${db.schema}"`);
      await client.query(FIXTURE_SQL);
      // Read the expression back as PostgreSQL stored it. This is the test
      // reading the catalog, not the product: the product's side of the claim
      // is asserted in @kozou/introspect.
      const res = await client.query<{
        using_expr: string | null;
        check_expr: string | null;
        node_tree: string | null;
      }>(
        `SELECT pg_get_expr(polqual, polrelid) AS using_expr,
                pg_get_expr(polwithcheck, polrelid) AS check_expr,
                polqual::text AS node_tree
           FROM pg_policy
          WHERE polrelid = to_regclass($1)`,
        [`"${db.schema}".orders`],
      );
      storedPolicy = res.rows[0] ?? { using_expr: null, check_expr: null, node_tree: null };
    } finally {
      await client.end();
    }

    const raw = await introspect({ connection: db.connectionString, schemas: [db.schema] });
    ctx = await buildSchemaContext({ raw });
  }, 120_000);

  afterAll(async () => {
    if (db) await db.cleanup();
  });

  it('positive control: the canary really is in the stored policy', () => {
    expect(storedPolicy.using_expr).toContain(CANARY);
    expect(storedPolicy.check_expr).toContain(CANARY);
    // And in its raw expression-tree spelling, which is what a whole-row read
    // of pg_policy would carry. Without this, CANARY_BYTES could be a pattern
    // that matches nothing anywhere — a sweep for it would then be theatre.
    expect(storedPolicy.node_tree).toContain(CANARY_BYTES);
  });

  it('is absent from the compiled schema context', async () => {
    const raw = await introspect({ connection: db.connectionString, schemas: [db.schema] });
    // The table is there, with its row-security signal — so the absence below
    // is about the expression, not about having introspected nothing.
    expect(JSON.stringify(raw)).toContain('"hasPolicies":true');
    for (const pattern of [CANARY, CANARY_BYTES]) {
      expect(JSON.stringify(raw)).not.toContain(pattern);
      expect(JSON.stringify(ctx)).not.toContain(pattern);
    }
  });

  it('is absent from every emitted surface', () => {
    const concepts = listConcepts({}, ctx).concepts;
    expect(concepts.length).toBeGreaterThan(0);

    // `must` is a string the surface has to carry: "no canary" in an empty
    // payload is the trivial truth, not the property under test.
    const surfaces: { name: string; text: string; must: string }[] = [
      {
        name: 'list_tables',
        text: JSON.stringify(listTables({ schema: db.schema }, ctx)),
        must: 'orders',
      },
      {
        name: 'describe_table',
        text: JSON.stringify(describeTable({ qualifiedName: `${db.schema}.orders` }, ctx)),
        must: 'tenant',
      },
      {
        name: 'list_views',
        text: JSON.stringify(listViews({ schema: db.schema }, ctx)),
        must: 'recent_orders',
      },
      {
        name: 'describe_view',
        text: JSON.stringify(describeView({ qualifiedName: `${db.schema}.recent_orders` }, ctx)),
        must: 'recent_orders',
      },
      { name: 'list_concepts', text: JSON.stringify(concepts), must: 'orders' },
      ...concepts.map((c) => ({
        name: `get_concept_context(${c.name})`,
        text: JSON.stringify(getConceptContext({ name: c.name }, ctx)),
        must: c.name,
      })),
      {
        name: 'describe_functions',
        text: JSON.stringify(describeFunctions({}, ctx)),
        must: 'order_total',
      },
      {
        // Hits only, not the whole payload: `search_schema` echoes the query
        // it was given, so `must` would be satisfied by the echo and this
        // entry would report itself as covered while emitting nothing.
        name: 'search_schema',
        text: JSON.stringify(searchSchema({ query: 'orders' }, ctx).hits),
        must: 'orders',
      },
      { name: 'kozou docs', text: emitMarkdown(ctx), must: 'orders' },
      { name: 'openapi', text: JSON.stringify(buildOpenApiDocument(ctx)), must: 'orders' },
    ];

    const leaking = surfaces
      .filter((s) => s.text.includes(CANARY) || s.text.includes(CANARY_BYTES))
      .map((s) => s.name);
    expect(leaking).toEqual([]);

    const silent = surfaces.filter((s) => !s.text.includes(s.must)).map((s) => s.name);
    expect(silent).toEqual([]);
  });

  // Searched for directly, rather than swept up in a payload. The output is
  // asserted on its hits: `search_schema` echoes the query it was given, so a
  // whole-payload check would report the echo as a leak and prove nothing
  // either way.
  it('is not findable through search_schema', () => {
    const out = searchSchema({ query: CANARY }, ctx);
    expect(out.hits).toEqual([]);
    // The searcher works — the same call shape finds the fixture by name.
    expect(searchSchema({ query: 'orders' }, ctx).hits.length).toBeGreaterThan(0);
  });
});
