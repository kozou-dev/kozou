import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pkg from 'pg';
import { buildSchemaContext } from '@kozou/core';
import { setupDatabase, type DatabaseHandle } from '@kozou/test-utils';
import { introspect } from '@kozou/introspect';
import { describeFunctions, describeFunctionsOutputSchema, SchemaCache } from '../src/index.js';

// describe_functions (issue #103, RPC design §5.3): the read tool that lets an
// AI agent learn the exposed RPC actions — signatures plus the schema author's
// @ai / @policy advisory.
const FIXTURE_SQL = `
  CREATE TYPE order_status AS ENUM ('pending', 'shipped');

  -- invoker, exposed (tagged + PUBLIC EXECUTE revoked)
  CREATE FUNCTION approve_order(order_id uuid, status order_status, note text DEFAULT '')
    RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;
  COMMENT ON FUNCTION approve_order(uuid, order_status, text) IS 'Approve an order.
@ai: not idempotent — check status before re-calling.
@policy: only managers may approve.
@arg: order_id relation(orders.id)
@expose: rpc';
  REVOKE EXECUTE ON FUNCTION approve_order(uuid, order_status, text) FROM PUBLIC;

  -- a SECURITY DEFINER function, exposed only when the operator opts in
  CREATE FUNCTION settle(invoice_id uuid) RETURNS void
    LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ SELECT $$;
  COMMENT ON FUNCTION settle(uuid) IS 'Settle an invoice.
@expose: rpc';
  REVOKE EXECUTE ON FUNCTION settle(uuid) FROM PUBLIC;

  -- a SETOF (RETURNS TABLE) function: describe surfaces the row columns
  CREATE FUNCTION recent_orders(n integer) RETURNS TABLE(id uuid, status order_status)
    LANGUAGE sql AS $$ SELECT gen_random_uuid(), 'pending'::order_status $$;
  COMMENT ON FUNCTION recent_orders(integer) IS 'Recent orders.
@expose: rpc';
  REVOKE EXECUTE ON FUNCTION recent_orders(integer) FROM PUBLIC;

  -- an untagged helper: must never appear
  CREATE FUNCTION internal_helper() RETURNS integer LANGUAGE sql AS $$ SELECT 0 $$;
`;

describe('describe_functions (MCP, issue #103)', () => {
  let db: DatabaseHandle;

  beforeAll(async () => {
    db = await setupDatabase();
    const client = new pkg.Client({ connectionString: db.connectionString });
    await client.connect();
    try {
      await client.query(`CREATE SCHEMA "${db.schema}"`);
      await client.query(`SET search_path TO "${db.schema}"`);
      await client.query(FIXTURE_SQL);
    } finally {
      await client.end();
    }
  }, 120_000);

  afterAll(async () => {
    if (db) await db.cleanup();
  });

  it('describes an exposed invoker function with signature + @ai / @policy', async () => {
    const raw = await introspect({ connection: db.connectionString, schemas: [db.schema] });
    const ctx = await buildSchemaContext({ raw });
    const out = describeFunctions({}, ctx);
    expect(describeFunctionsOutputSchema.parse(out)).toEqual(out); // shape is valid

    const fn = out.functions.find((f) => f.qualifiedName === `${db.schema}.approve_order`);
    expect(fn).toBeDefined();
    expect(fn!.aiDescription).toMatch(/not idempotent/);
    expect(fn!.policy).toEqual(['only managers may approve.']);
    expect(fn!.security).toBe('invoker');
    expect(fn!.returns).toMatchObject({ kind: 'scalar', typeName: 'integer' });
    expect(fn!.args.map((a) => a.name)).toEqual(['order_id', 'status', 'note']);
    // note has a DEFAULT.
    expect(fn!.args.find((a) => a.name === 'note')!.hasDefault).toBe(true);
    // enum arg surfaces its members; the @arg relation hint is resolved.
    expect(fn!.args.find((a) => a.name === 'status')!.enumValues).toEqual(['pending', 'shipped']);
    expect(fn!.args.find((a) => a.name === 'order_id')!.relation).toBe(`${db.schema}.orders.id`);
  });

  it('surfaces the row columns of a SETOF (RETURNS TABLE) function', async () => {
    const raw = await introspect({ connection: db.connectionString, schemas: [db.schema] });
    const ctx = await buildSchemaContext({ raw });
    const fn = describeFunctions({}, ctx).functions.find(
      (f) => f.qualifiedName === `${db.schema}.recent_orders`,
    );
    expect(fn).toBeDefined();
    expect(fn!.returns.kind).toBe('setof');
    expect(fn!.returns.columns?.map((c) => c.name)).toEqual(['id', 'status']);
  });

  it('never lists an untagged function', async () => {
    const raw = await introspect({ connection: db.connectionString, schemas: [db.schema] });
    const ctx = await buildSchemaContext({ raw });
    const names = describeFunctions({}, ctx).functions.map((f) => f.qualifiedName);
    expect(names).not.toContain(`${db.schema}.internal_helper`);
  });

  it('omits a SECURITY DEFINER function until the operator opts it in (allowDefiner)', async () => {
    // Without the rpc config, the definer is not exposed.
    const cacheClosed = new SchemaCache({ connection: db.connectionString, schemas: [db.schema] });
    const closed = describeFunctions({}, await cacheClosed.get()).functions.map(
      (f) => f.qualifiedName,
    );
    expect(closed).not.toContain(`${db.schema}.settle`);
    expect(closed).toContain(`${db.schema}.approve_order`);

    // With allowDefiner, the SchemaCache threads it through and the definer appears.
    const cacheOpen = new SchemaCache({
      connection: db.connectionString,
      schemas: [db.schema],
      rpc: { allowDefiner: [`${db.schema}.settle`] },
    });
    const opened = describeFunctions({}, await cacheOpen.get()).functions;
    const settle = opened.find((f) => f.qualifiedName === `${db.schema}.settle`);
    expect(settle).toBeDefined();
    expect(settle!.security).toBe('definer');
    expect(settle!.returns.kind).toBe('void');
  });
});
