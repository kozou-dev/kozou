import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pkg from 'pg';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { buildSchemaContext, type SchemaContext } from '@kozou/core';
import { introspect } from '@kozou/introspect';
import { setupDatabase, type DatabaseHandle } from '@kozou/test-utils';

import { SchemaCache, callTool, startHttpServer, type McpExecution } from '../src/index.js';

// The `call` execution tool (issue #103, MCP). Proven end-to-end against a real
// PostgreSQL: a call runs under the operator's execution role via the shared
// role-transaction envelope, so EXECUTE privilege + RLS apply; a raw database
// message is never returned to the caller. All fixture functions are
// table-free (current_user / current_setting / arithmetic / VALUES) so they
// need no search_path beyond the call itself.
const FIXTURE_SQL = `
  -- A dedicated least-privilege execution role the connection can SET ROLE to.
  CREATE ROLE mcp_agent NOLOGIN;
  GRANT mcp_agent TO CURRENT_USER;

  -- current_user proves the call ran under SET LOCAL ROLE mcp_agent.
  CREATE FUNCTION whoami() RETURNS text LANGUAGE sql AS $$ SELECT current_user::text $$;
  COMMENT ON FUNCTION whoami() IS 'Executing role.
@expose: rpc';
  REVOKE EXECUTE ON FUNCTION whoami() FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION whoami() TO mcp_agent;

  -- Reads the published claims (proves the claims plumbing + GUC).
  CREATE FUNCTION my_claims() RETURNS text LANGUAGE sql STABLE
    AS $$ SELECT current_setting('request.jwt.claims', true) $$;
  COMMENT ON FUNCTION my_claims() IS 'Published JWT claims.
@expose: rpc';
  REVOKE EXECUTE ON FUNCTION my_claims() FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION my_claims() TO mcp_agent;

  -- Scalar return + required args (drives pre-flight).
  CREATE FUNCTION add_two(a integer, b integer) RETURNS integer LANGUAGE sql
    AS $$ SELECT a + b $$;
  COMMENT ON FUNCTION add_two(integer, integer) IS 'Sum two integers.
@expose: rpc';
  REVOKE EXECUTE ON FUNCTION add_two(integer, integer) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION add_two(integer, integer) TO mcp_agent;

  -- void return (drives the "executed, no value" note).
  CREATE FUNCTION do_nothing() RETURNS void LANGUAGE sql AS $$ SELECT $$;
  COMMENT ON FUNCTION do_nothing() IS 'No-op.
@expose: rpc';
  REVOKE EXECUTE ON FUNCTION do_nothing() FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION do_nothing() TO mcp_agent;

  -- SETOF scalar (drives array shaping).
  CREATE FUNCTION two_rows() RETURNS SETOF integer LANGUAGE sql
    AS $$ SELECT * FROM (VALUES (10), (20)) AS v(n) $$;
  COMMENT ON FUNCTION two_rows() IS 'Two rows.
@expose: rpc';
  REVOKE EXECUTE ON FUNCTION two_rows() FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION two_rows() TO mcp_agent;

  -- Exposed but NOT granted to mcp_agent: calling it must be denied (42501).
  CREATE FUNCTION forbidden_op() RETURNS void LANGUAGE sql AS $$ SELECT $$;
  COMMENT ON FUNCTION forbidden_op() IS 'Not granted to the agent.
@expose: rpc';
  REVOKE EXECUTE ON FUNCTION forbidden_op() FROM PUBLIC;

  -- RAISEs with a secret-looking message: the raw text must never be returned.
  CREATE FUNCTION boom() RETURNS void LANGUAGE plpgsql
    AS $$ BEGIN RAISE EXCEPTION 'kaboom internal secret detail'; END $$;
  COMMENT ON FUNCTION boom() IS 'Always fails.
@expose: rpc';
  REVOKE EXECUTE ON FUNCTION boom() FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION boom() TO mcp_agent;

  -- SECURITY DEFINER: runs as its owner, NOT the agent — the sharpest edge.
  -- Owner-safe search_path so the exposure decision keeps it (with allowDefiner).
  CREATE FUNCTION definer_who() RETURNS text LANGUAGE sql SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp AS $$ SELECT current_user::text $$;
  COMMENT ON FUNCTION definer_who() IS 'Owner role (definer).
@expose: rpc';
  REVOKE EXECUTE ON FUNCTION definer_who() FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION definer_who() TO mcp_agent;

  -- An untagged helper: never exposed, never callable.
  CREATE FUNCTION internal_helper() RETURNS integer LANGUAGE sql AS $$ SELECT 0 $$;
`;

function textOf(result: { content: { type: string; text: string }[] }): string {
  return result.content.map((c) => c.text).join('');
}

describe('callTool (MCP execution, issue #103)', () => {
  let db: DatabaseHandle;
  let pool: pkg.Pool;
  let ctx: SchemaContext;
  let ownerRole: string;
  const qn = (name: string): string => `${db.schema}.${name}`;
  let execution: McpExecution;

  beforeAll(async () => {
    db = await setupDatabase();
    const admin = new pkg.Client({ connectionString: db.connectionString });
    await admin.connect();
    try {
      await admin.query(`CREATE SCHEMA "${db.schema}"`);
      await admin.query(`SET search_path TO "${db.schema}"`);
      await admin.query(FIXTURE_SQL);
      await admin.query(`GRANT USAGE ON SCHEMA "${db.schema}" TO mcp_agent`);
      ownerRole = (await admin.query<{ current_user: string }>('SELECT current_user')).rows[0]
        .current_user;
    } finally {
      await admin.end();
    }

    const raw = await introspect({ connection: db.connectionString, schemas: [db.schema] });
    // allowDefiner opts the SECURITY DEFINER function into the exposed set.
    ctx = await buildSchemaContext({
      raw,
      rpc: { allowDefiner: [qn('definer_who')], allowPublicExecute: [] },
    });

    pool = new pkg.Pool({ connectionString: db.connectionString, max: 4 });
    execution = {
      pool,
      role: 'mcp_agent',
      claimsGuc: 'request.jwt.claims',
      claims: { sub: 'agent-x' },
    };
  }, 120_000);

  afterAll(async () => {
    if (pool) await pool.end();
    if (db) await db.cleanup();
  });

  it('runs a granted function under SET LOCAL ROLE (current_user is the exec role)', async () => {
    const r = await callTool({ function: qn('whoami') }, ctx, execution);
    expect(r.isError).toBeUndefined();
    expect(JSON.parse(textOf(r))).toBe('mcp_agent');
  });

  it('publishes the configured claims for RLS under request.jwt.claims', async () => {
    const r = await callTool({ function: qn('my_claims') }, ctx, execution);
    expect(r.isError).toBeUndefined();
    // my_claims returns the GUC's TEXT value (the claims JSON), so the scalar
    // result is the JSON string — parse once for the scalar, again for its JSON.
    const claimsText = JSON.parse(textOf(r)) as string;
    expect(JSON.parse(claimsText)).toEqual({ sub: 'agent-x' });
  });

  it('returns a scalar result and binds named arguments', async () => {
    const r = await callTool({ function: qn('add_two'), args: { a: 2, b: 5 } }, ctx, execution);
    expect(JSON.parse(textOf(r))).toBe(7);
  });

  it('reports a void function as executed with no value', async () => {
    const r = await callTool({ function: qn('do_nothing') }, ctx, execution);
    expect(r.isError).toBeUndefined();
    expect(JSON.parse(textOf(r))).toEqual({ ok: true, note: expect.stringContaining('no value') });
  });

  it('returns a SETOF scalar as an array', async () => {
    const r = await callTool({ function: qn('two_rows') }, ctx, execution);
    expect(JSON.parse(textOf(r))).toEqual([10, 20]);
  });

  it('pre-flights an unknown argument as an error (no query runs)', async () => {
    const r = await callTool({ function: qn('add_two'), args: { a: 1, b: 2, c: 3 } }, ctx, execution);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/Unknown argument "c"/);
  });

  it('pre-flights a missing required argument as an error', async () => {
    const r = await callTool({ function: qn('add_two'), args: { a: 1 } }, ctx, execution);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/Missing required argument "b"/);
  });

  it('maps a missing EXECUTE privilege (42501) to a safe error with no leak', async () => {
    const r = await callTool({ function: qn('forbidden_op') }, ctx, execution);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe('Permission denied.');
    // No raw database detail (function name / privilege wording) leaks.
    expect(textOf(r)).not.toContain('forbidden_op');
    expect(textOf(r)).not.toMatch(/permission denied for/i);
  });

  it('maps a RAISE to a generic error without leaking the raw message', async () => {
    const r = await callTool({ function: qn('boom') }, ctx, execution);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe('The function call failed.');
    expect(textOf(r)).not.toContain('kaboom');
  });

  it('runs a SECURITY DEFINER function as its owner, not the exec role', async () => {
    const r = await callTool({ function: qn('definer_who') }, ctx, execution);
    expect(r.isError).toBeUndefined();
    const who = JSON.parse(textOf(r)) as string;
    expect(who).toBe(ownerRole);
    expect(who).not.toBe('mcp_agent');
  });

  it('treats an unknown / unexposed function as non-existent (no enumeration)', async () => {
    const unexposed = await callTool({ function: qn('internal_helper') }, ctx, execution);
    expect(unexposed.isError).toBe(true);
    expect(textOf(unexposed)).toMatch(/Unknown function/);

    const missing = await callTool({ function: qn('does_not_exist') }, ctx, execution);
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toMatch(/Unknown function/);
  });

  it('enforces the allowlist: a not-allowed exposed function is indistinguishable from absent', async () => {
    const allowlisted: McpExecution = { ...execution, allow: [qn('whoami')] };
    // Allowed → runs.
    expect((await callTool({ function: qn('whoami') }, ctx, allowlisted)).isError).toBeUndefined();
    // Exposed + granted, but not on the allowlist → same "Unknown function".
    const blocked = await callTool({ function: qn('add_two'), args: { a: 1, b: 1 } }, ctx, allowlisted);
    expect(blocked.isError).toBe(true);
    expect(textOf(blocked)).toMatch(/Unknown function/);
  });

  it('rejects a malformed input shape', async () => {
    expect((await callTool({}, ctx, execution)).isError).toBe(true);
    expect((await callTool({ function: '' }, ctx, execution)).isError).toBe(true);
    const badArgs = await callTool({ function: qn('add_two'), args: [1, 2] }, ctx, execution);
    expect(badArgs.isError).toBe(true);
    expect(textOf(badArgs)).toMatch(/Invalid call input/);
  });
});

describe('MCP server call-tool wiring (over HTTP transport)', () => {
  let db: DatabaseHandle;
  let pool: pkg.Pool;
  let cache: SchemaCache;

  beforeAll(async () => {
    db = await setupDatabase();
    const admin = new pkg.Client({ connectionString: db.connectionString });
    await admin.connect();
    try {
      await admin.query(`CREATE SCHEMA "${db.schema}"`);
      await admin.query(`SET search_path TO "${db.schema}"`);
      await admin.query(`
        CREATE ROLE mcp_agent NOLOGIN;
        GRANT mcp_agent TO CURRENT_USER;
        CREATE FUNCTION whoami() RETURNS text LANGUAGE sql AS $$ SELECT current_user::text $$;
        COMMENT ON FUNCTION whoami() IS 'Executing role.
@expose: rpc';
        REVOKE EXECUTE ON FUNCTION whoami() FROM PUBLIC;
        GRANT EXECUTE ON FUNCTION whoami() TO mcp_agent;
      `);
      await admin.query(`GRANT USAGE ON SCHEMA "${db.schema}" TO mcp_agent`);
    } finally {
      await admin.end();
    }
    cache = new SchemaCache({ connection: db.connectionString, schemas: [db.schema], ttlMs: 60_000 });
    pool = new pkg.Pool({ connectionString: db.connectionString, max: 2 });
  }, 120_000);

  afterAll(async () => {
    if (pool) await pool.end();
    if (db) await db.cleanup();
  });

  const execution = (): McpExecution => ({
    pool,
    role: 'mcp_agent',
    claimsGuc: 'request.jwt.claims',
    claims: {},
  });

  it('lists + runs the call tool when execution is enabled', async () => {
    const handle = await startHttpServer(cache, { port: 0, host: '127.0.0.1', execution: execution() });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${handle.port}/mcp`),
    );
    const client = new Client({ name: 'kozou-test', version: '0.0.0' });
    try {
      await client.connect(transport);
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toContain('call');

      const result = await client.callTool({
        name: 'call',
        arguments: { function: `${db.schema}.whoami` },
      });
      const content = result.content as Array<{ type: string; text: string }>;
      expect(JSON.parse(content[0].text)).toBe('mcp_agent');
    } finally {
      await client.close();
      await handle.close();
    }
  });

  it('omits the call tool (and refuses it) when execution is disabled', async () => {
    const handle = await startHttpServer(cache, { port: 0, host: '127.0.0.1' });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${handle.port}/mcp`),
    );
    const client = new Client({ name: 'kozou-test', version: '0.0.0' });
    try {
      await client.connect(transport);
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).not.toContain('call');

      // A client could still send the name; it must be refused, not run.
      const result = await client.callTool({
        name: 'call',
        arguments: { function: `${db.schema}.whoami` },
      });
      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0].text).toMatch(/not enabled/);
    } finally {
      await client.close();
      await handle.close();
    }
  });

  it('reports schema-unavailable generically when introspection fails (no leak)', async () => {
    // A call reaches the shared cache.get() before callTool; an introspection
    // failure must not echo the raw connection error to the client.
    const badCache = new SchemaCache({
      connection: 'postgres://invalid-host-xyz:5432/none',
      schemas: ['public'],
      ttlMs: 60_000,
    });
    const handle = await startHttpServer(badCache, {
      port: 0,
      host: '127.0.0.1',
      execution: execution(),
    });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${handle.port}/mcp`),
    );
    const client = new Client({ name: 'kozou-test', version: '0.0.0' });
    try {
      await client.connect(transport);
      const result = await client.callTool({
        name: 'call',
        arguments: { function: 'public.whoami' },
      });
      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0].text).toBe('Schema is currently unavailable.');
      // The raw connection error (host, driver code) must not leak.
      expect(content[0].text).not.toMatch(/invalid-host-xyz|ENOTFOUND|ECONNREFUSED|getaddrinfo/i);
    } finally {
      await client.close();
      await handle.close();
    }
  });

  it('escalates the non-loopback warning when execution is enabled', async () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    let handle;
    try {
      handle = await startHttpServer(cache, { port: 0, host: '0.0.0.0', execution: execution() });
    } finally {
      spy.mockRestore();
    }
    await handle.close();
    const warning = writes.join('');
    expect(warning).toMatch(/NO authentication/);
    expect(warning).toMatch(/`call` execution tool is ENABLED/);
    expect(warning).toContain('mcp_agent');
  });
});
