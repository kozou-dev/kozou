// OAuth 2.1 resource-server mode of the MCP Streamable HTTP transport.
//
// Covers the resolved metadata (RFC 9728 document + serving paths), the
// challenge semantics (401 for token problems with a resource_metadata
// pointer, 403 for role problems, 403 insufficient_scope for scope ones),
// the deliberate divergences from the REST surface (no anonymous access,
// no default role — a role-claim-less token is rejected), scope-gated tool
// advertising/dispatch, the /admin/refresh opt-in, and — against a real
// PostgreSQL — that `call` runs as each verified token's role with the
// token's claims published for RLS.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pkg from 'pg';
import { request as httpRequest } from 'node:http';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { signServiceToken } from '@kozou/core/auth';
import { buildSchemaContext, type ConnectionPool, type RawIntrospection } from '@kozou/core';
import { setupDatabase, type DatabaseHandle } from '@kozou/test-utils';

import {
  SchemaCache,
  createMcpServer,
  startHttpServer,
  type HttpServerHandle,
  type McpExecution,
} from '../src/index.js';
import { extractScopes, resolveMcpHttpAuth } from '../src/httpAuth.js';

const SECRET = 'httpauth-test-secret-0123456789abcdef';
const RESOURCE = 'https://mcp.example.com/mcp';
const ISSUERS = ['https://as.example.com/realms/kozou'];

/** Mint an HS256 token the server under test accepts (audience defaults to
 *  the canonical resource, issuer to the advertised AS — the server binds
 *  `iss` to it; role/scope as given). */
function mint(opts: {
  role?: string;
  scope?: string;
  audience?: string;
  issuer?: string;
}): Promise<string> {
  return signServiceToken({
    secret: SECRET,
    audience: opts.audience ?? RESOURCE,
    issuer: opts.issuer ?? ISSUERS[0],
    ...(opts.role === undefined ? {} : { role: opts.role }),
    ...(opts.scope === undefined ? {} : { claims: { scope: opts.scope } }),
  });
}

/** Raw request keeping full control of headers; resolves with status,
 *  headers, and parsed JSON body (undefined when not JSON). */
function raw(
  port: number,
  opts: { method?: string; path?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; json?: unknown }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, method: opts.method ?? 'GET', path: opts.path ?? '/', headers: opts.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: unknown;
          try {
            json = text.length > 0 ? JSON.parse(text) : undefined;
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, json });
        });
      },
    );
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

describe('resolveMcpHttpAuth', () => {
  const base = { resource: RESOURCE, authorizationServers: ISSUERS, jwt: { secret: SECRET } };

  it('builds the RFC 9728 metadata document with no schema information', () => {
    const auth = resolveMcpHttpAuth({ ...base, extraScopesSupported: ['offline_access'] }, '/mcp');
    expect(JSON.parse(auth.prmBody)).toEqual({
      resource: RESOURCE,
      authorization_servers: ISSUERS,
      scopes_supported: ['mcp:describe', 'mcp:execute', 'offline_access'],
      bearer_methods_supported: ['header'],
    });
  });

  it('does not advertise the admin scope even when adminRefresh is enabled', () => {
    const auth = resolveMcpHttpAuth({ ...base, adminRefresh: true }, '/mcp');
    const doc = JSON.parse(auth.prmBody) as { scopes_supported: string[] };
    expect(doc.scopes_supported).not.toContain('mcp:admin');
  });

  it('serves the root form and the path-insertion forms of the metadata path', () => {
    const auth = resolveMcpHttpAuth(base, '/mcp');
    expect([...auth.prmPaths].sort()).toEqual([
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/mcp',
    ]);
    expect(auth.resourceMetadataUrl).toBe(
      'https://mcp.example.com/.well-known/oauth-protected-resource/mcp',
    );
  });

  it('adds a distinct path-insertion form when the local path differs from the resource path', () => {
    const auth = resolveMcpHttpAuth({ ...base, resource: 'https://mcp.example.com' }, '/local-mcp');
    expect([...auth.prmPaths].sort()).toEqual([
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/local-mcp',
    ]);
    // A path-less resource challenges with the root form.
    expect(auth.resourceMetadataUrl).toBe(
      'https://mcp.example.com/.well-known/oauth-protected-resource',
    );
  });

  it('honours renamed scopes', () => {
    const auth = resolveMcpHttpAuth(
      { ...base, scopes: { describe: 'api://kozou/mcp.describe', execute: 'api://kozou/mcp.execute' } },
      '/mcp',
    );
    expect(auth.scopes.describe).toBe('api://kozou/mcp.describe');
    const doc = JSON.parse(auth.prmBody) as { scopes_supported: string[] };
    expect(doc.scopes_supported).toContain('api://kozou/mcp.execute');
  });

  it('rejects a malformed resource URI, a query/fragment, and a non-http scheme', () => {
    expect(() => resolveMcpHttpAuth({ ...base, resource: 'not a url' }, '/mcp')).toThrow(/valid URL/);
    expect(() => resolveMcpHttpAuth({ ...base, resource: 'https://x.example/mcp?x=1' }, '/mcp')).toThrow(
      /query or fragment/,
    );
    expect(() => resolveMcpHttpAuth({ ...base, resource: 'ftp://x.example/mcp' }, '/mcp')).toThrow(
      /http\(s\)/,
    );
  });

  it('rejects an empty or malformed authorization-server list', () => {
    expect(() => resolveMcpHttpAuth({ ...base, authorizationServers: [] }, '/mcp')).toThrow(
      /at least one issuer/,
    );
    expect(() => resolveMcpHttpAuth({ ...base, authorizationServers: ['nope'] }, '/mcp')).toThrow(
      /not a valid URL/,
    );
    expect(
      () => resolveMcpHttpAuth({ ...base, authorizationServers: ['ftp://as.example.com'] }, '/mcp'),
    ).toThrow(/http\(s\)/);
  });

  it('rejects a plaintext http resource or authorization server on a non-loopback host', () => {
    expect(() => resolveMcpHttpAuth({ ...base, resource: 'http://mcp.example.com/mcp' }, '/mcp')).toThrow(
      /plaintext http on a non-loopback host/,
    );
    expect(
      () => resolveMcpHttpAuth({ ...base, authorizationServers: ['http://as.example.com'] }, '/mcp'),
    ).toThrow(/plaintext http on a non-loopback host/);
  });

  it('always allows plaintext http on loopback (local development)', () => {
    for (const host of ['127.0.0.1', '127.1.2.3', 'localhost', '[::1]']) {
      const auth = resolveMcpHttpAuth(
        {
          ...base,
          resource: `http://${host}:3334/mcp`,
          authorizationServers: [`http://${host}:8080/realms/kozou`],
        },
        '/mcp',
      );
      expect(auth.insecureHttpUrls).toEqual([]);
    }
  });

  it('allowInsecureHttp waves a non-loopback http URL through and surfaces it for the warning', () => {
    const auth = resolveMcpHttpAuth(
      {
        ...base,
        resource: 'http://mcp.internal:3334/mcp',
        authorizationServers: ['http://keycloak.internal:8080/realms/kozou'],
        allowInsecureHttp: true,
      },
      '/mcp',
    );
    expect(auth.insecureHttpUrls).toEqual([
      'http://mcp.internal:3334/mcp',
      'http://keycloak.internal:8080/realms/kozou',
    ]);
  });
});

describe('extractScopes', () => {
  it('reads the space-delimited `scope` claim', () => {
    expect([...extractScopes({ scope: 'mcp:describe  mcp:execute' })].sort()).toEqual([
      'mcp:describe',
      'mcp:execute',
    ]);
  });

  it('reads `scp` as a string or an array, merged with `scope`', () => {
    expect([...extractScopes({ scp: 'a b' })].sort()).toEqual(['a', 'b']);
    expect([...extractScopes({ scp: ['a', 'b'] })].sort()).toEqual(['a', 'b']);
    expect([...extractScopes({ scope: 'a', scp: ['b'] })].sort()).toEqual(['a', 'b']);
  });

  it('ignores non-string values', () => {
    expect(extractScopes({ scope: 42, scp: [1, null] }).size).toBe(0);
    expect(extractScopes({}).size).toBe(0);
  });
});

describe('OAuth RS mode: metadata + challenges (no database)', () => {
  let handle: HttpServerHandle;
  let cache: SchemaCache;
  let port: number;

  beforeAll(async () => {
    // These assertions never reach SchemaCache.get(), so a connection string
    // that is never dialed is sufficient.
    cache = new SchemaCache({ connection: 'postgres://invalid:5432/none' });
    handle = await startHttpServer(cache, {
      port: 0,
      host: '127.0.0.1',
      auth: {
        resource: RESOURCE,
        authorizationServers: ISSUERS,
        jwt: { secret: SECRET },
        allowedRoles: ['mcp_rs_viewer', 'mcp_rs_editor'],
      },
    });
    port = handle.port;
  });

  afterAll(async () => {
    if (handle) await handle.close();
  });

  it('serves the metadata unauthenticated on both forms, GET-only', async () => {
    for (const path of [
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/mcp',
    ]) {
      const res = await raw(port, { path });
      expect(res.status).toBe(200);
      expect((res.json as { resource: string }).resource).toBe(RESOURCE);
    }
    expect((await raw(port, { method: 'POST', path: '/.well-known/oauth-protected-resource' })).status).toBe(405);
  });

  it('keeps the DNS-rebinding guard on the metadata, and auto-allows the resource host', async () => {
    const bad = await raw(port, {
      path: '/.well-known/oauth-protected-resource',
      headers: { host: 'attacker.example:1234' },
    });
    expect(bad.status).toBe(403);
    const viaResourceHost = await raw(port, {
      path: '/.well-known/oauth-protected-resource',
      headers: { host: 'mcp.example.com' },
    });
    expect(viaResourceHost.status).toBe(200);
  });

  it('challenges a tokenless MCP request with 401 + resource_metadata (no error attribute)', async () => {
    const res = await raw(port, { method: 'POST', path: '/mcp' });
    expect(res.status).toBe(401);
    const challenge = res.headers['www-authenticate'] as string;
    expect(challenge).toBe(
      'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"',
    );
    expect(JSON.stringify(res.json)).not.toMatch(/signature|expired|audience|issuer/i);
  });

  it('rejects a garbage token with 401 error="invalid_token" and a generic message', async () => {
    const res = await raw(port, {
      method: 'POST',
      path: '/mcp',
      headers: { authorization: 'Bearer not-a-jwt' },
    });
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toMatch(/^Bearer error="invalid_token", resource_metadata=/);
  });

  it('rejects a token whose audience is not the canonical resource (401, generic)', async () => {
    const token = await mint({
      role: 'mcp_rs_viewer',
      scope: 'mcp:describe',
      audience: 'https://rest.example.com/api',
    });
    const res = await raw(port, {
      method: 'POST',
      path: '/mcp',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.json)).not.toMatch(/aud/i);
  });

  it('rejects a token whose iss is not an advertised authorization server (401)', async () => {
    // The server binds accepted iss to the advertised authorizationServers even
    // when the config sets no explicit jwt.issuer — a token from a different
    // realm signed with the same key material must not be accepted.
    const token = await mint({
      role: 'mcp_rs_viewer',
      scope: 'mcp:describe',
      issuer: 'https://other-realm.example.com',
    });
    const res = await raw(port, {
      method: 'POST',
      path: '/mcp',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.json)).not.toMatch(/iss/i);
  });

  it('rejects a token with no iss claim when the issuer is bound (401)', async () => {
    const token = await signServiceToken({
      secret: SECRET,
      audience: RESOURCE,
      role: 'mcp_rs_viewer',
      claims: { scope: 'mcp:describe' },
      // deliberately no issuer
    });
    const res = await raw(port, {
      method: 'POST',
      path: '/mcp',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });

  it('rejects a token without a role claim (403 — no default role on this surface)', async () => {
    const token = await mint({ scope: 'mcp:describe' });
    const res = await raw(port, {
      method: 'POST',
      path: '/mcp',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
    expect(res.headers['www-authenticate']).toBeUndefined();
  });

  it('rejects a token whose role is not in allowedRoles (403)', async () => {
    const token = await mint({ role: 'postgres', scope: 'mcp:describe' });
    const res = await raw(port, {
      method: 'POST',
      path: '/mcp',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
  });

  it('refuses a token carrying no recognised scope with 403 insufficient_scope', async () => {
    const token = await mint({ role: 'mcp_rs_viewer', scope: 'openid profile' });
    const res = await raw(port, {
      method: 'POST',
      path: '/mcp',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
    expect(res.headers['www-authenticate']).toBe(
      'Bearer error="insufficient_scope", scope="mcp:describe", ' +
        'resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"',
    );
  });

  it('gates tools/call on the required scope at the HTTP layer (403 insufficient_scope)', async () => {
    const describeOnly = await mint({ role: 'mcp_rs_viewer', scope: 'mcp:describe' });
    const jsonHeaders = (token: string, sessionId?: string): Record<string, string> => ({
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(sessionId === undefined ? {} : { 'mcp-session-id': sessionId }),
    });

    const init = await raw(port, {
      method: 'POST',
      path: '/mcp',
      headers: jsonHeaders(describeOnly),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'httpauth-test', version: '0.0.0' },
        },
      }),
    });
    expect(init.status).toBe(200);
    const sessionId = init.headers['mcp-session-id'] as string;
    expect(sessionId).toBeTruthy();

    // The execute-facet tool with a describe-only token: refused before the
    // transport, with the challenge a scope-upgrade-capable client expects.
    const call = await raw(port, {
      method: 'POST',
      path: '/mcp',
      headers: jsonHeaders(describeOnly, sessionId),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'call', arguments: { function: 'public.whatever' } },
      }),
    });
    expect(call.status).toBe(403);
    expect(call.headers['www-authenticate']).toMatch(/error="insufficient_scope", scope="mcp:execute"/);

    // And the describe facet needs the describe scope: same message shape
    // with the other scope named.
    const executeOnly = await mint({ role: 'mcp_rs_viewer', scope: 'mcp:execute' });
    const describeCall = await raw(port, {
      method: 'POST',
      path: '/mcp',
      headers: jsonHeaders(executeOnly, sessionId),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'list_tables', arguments: {} },
      }),
    });
    expect(describeCall.status).toBe(403);
    expect(describeCall.headers['www-authenticate']).toMatch(
      /error="insufficient_scope", scope="mcp:describe"/,
    );

    // A JSON-RPC batch must not smuggle an execute call past the HTTP gate:
    // the transport still accepts batch arrays, so the scope scan covers them.
    const batch = await raw(port, {
      method: 'POST',
      path: '/mcp',
      headers: jsonHeaders(describeOnly, sessionId),
      body: JSON.stringify([
        { jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} },
        {
          jsonrpc: '2.0',
          id: 5,
          method: 'tools/call',
          params: { name: 'call', arguments: { function: 'public.whatever' } },
        },
      ]),
    });
    expect(batch.status).toBe(403);
    expect(batch.headers['www-authenticate']).toMatch(/error="insufficient_scope", scope="mcp:execute"/);
  });

  it('disables POST /admin/refresh by default in auth mode (404, like an unknown path)', async () => {
    const token = await mint({ role: 'mcp_rs_viewer', scope: 'mcp:describe mcp:admin' });
    const res = await raw(port, {
      method: 'POST',
      path: '/admin/refresh',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
  });
});

describe('OAuth RS mode: /admin/refresh opt-in', () => {
  let handle: HttpServerHandle;
  let cache: SchemaCache;

  beforeAll(async () => {
    cache = new SchemaCache({ connection: 'postgres://invalid:5432/none' });
    handle = await startHttpServer(cache, {
      port: 0,
      host: '127.0.0.1',
      auth: {
        resource: RESOURCE,
        authorizationServers: ISSUERS,
        jwt: { secret: SECRET },
        adminRefresh: true,
      },
    });
  });

  afterAll(async () => {
    if (handle) await handle.close();
  });

  it('requires a token (401) and the admin scope (403), then invalidates (200)', async () => {
    expect((await raw(handle.port, { method: 'POST', path: '/admin/refresh' })).status).toBe(401);

    const wrongScope = await mint({ role: 'mcp_rs_viewer', scope: 'mcp:describe mcp:execute' });
    const denied = await raw(handle.port, {
      method: 'POST',
      path: '/admin/refresh',
      headers: { authorization: `Bearer ${wrongScope}` },
    });
    expect(denied.status).toBe(403);
    expect(denied.headers['www-authenticate']).toMatch(/error="insufficient_scope", scope="mcp:admin"/);

    const spy = vi.spyOn(cache, 'invalidate');
    const admin = await mint({ role: 'mcp_rs_viewer', scope: 'mcp:admin' });
    const ok = await raw(handle.port, {
      method: 'POST',
      path: '/admin/refresh',
      headers: { authorization: `Bearer ${admin}` },
    });
    expect(ok.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

// tools/list filtering by scope, over the real HTTP transport with the SDK
// client. Execution is enabled with a pool that must never be dialed —
// listing never executes.
describe('OAuth RS mode: scope-gated tool advertising', () => {
  const deadPool = {
    connect: () => Promise.reject(new Error('the pool must not be used by tools/list')),
  } as unknown as ConnectionPool;
  let handle: HttpServerHandle;

  beforeAll(async () => {
    const cache = new SchemaCache({ connection: 'postgres://invalid:5432/none' });
    handle = await startHttpServer(cache, {
      port: 0,
      host: '127.0.0.1',
      execution: { pool: deadPool, claimsGuc: 'request.jwt.claims' },
      auth: { resource: RESOURCE, authorizationServers: ISSUERS, jwt: { secret: SECRET } },
    });
  });

  afterAll(async () => {
    if (handle) await handle.close();
  });

  async function listToolNames(scope: string): Promise<string[]> {
    const token = await mint({ role: 'mcp_rs_viewer', scope });
    const client = new Client({ name: 'httpauth-list', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${handle.port}/mcp`),
      { requestInit: { headers: { authorization: `Bearer ${token}` } } },
    );
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      return tools.map((t) => t.name).sort();
    } finally {
      await client.close();
    }
  }

  it('a describe-scope token sees the describe tools and not `call`', async () => {
    const names = await listToolNames('mcp:describe');
    expect(names).toContain('list_tables');
    expect(names).toContain('describe_functions');
    expect(names).not.toContain('call');
    expect(names).toHaveLength(7);
  });

  it('an execute-only token sees only `call`', async () => {
    expect(await listToolNames('mcp:execute')).toEqual(['call']);
  });

  it('a token with both scopes sees everything', async () => {
    expect(await listToolNames('mcp:describe mcp:execute')).toHaveLength(8);
  });
});

// Fail-closed dispatch: with a scope gate configured but no auth info on the
// request (a transport that never attached it), nothing is advertised and
// nothing dispatches.
describe('createMcpServer scope gate without auth info', () => {
  const RAW: RawIntrospection = {
    serverVersion: '16.2',
    introspectedAt: '2026-01-01T00:00:00.000Z',
    schemas: ['public'],
    enums: [],
    functions: [],
    tables: [],
    views: [],
  };

  it('advertises no tools and refuses dispatch', async () => {
    const ctx = await buildSchemaContext({ raw: RAW });
    const cache = { get: () => Promise.resolve(ctx), invalidate: () => {} } as unknown as SchemaCache;
    const server = createMcpServer(cache, undefined, {
      describe: 'mcp:describe',
      execute: 'mcp:execute',
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'httpauth-failclosed', version: '0.0.0' });
    await client.connect(clientTransport);
    try {
      const { tools } = await client.listTools();
      expect(tools).toEqual([]);
      const result = (await client.callTool({ name: 'list_tables', arguments: {} })) as {
        isError?: boolean;
        content: { type: string; text: string }[];
      };
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toMatch(/requires the "mcp:describe" scope/);
    } finally {
      await client.close();
    }
  });
});

// Per-token execution against a real PostgreSQL: the same `call` runs as
// whatever role the verified token carries, with the token's claims
// published — the RLS-facing identity is the caller's, not a fixed one.
//
// PostgreSQL roles are cluster-global and CI shares one cluster across the
// run, so the role names here are unique to this suite.
const RS_FIXTURE_SQL = `
  CREATE ROLE mcp_rs_viewer NOLOGIN;
  CREATE ROLE mcp_rs_editor NOLOGIN;
  GRANT mcp_rs_viewer TO CURRENT_USER;
  GRANT mcp_rs_editor TO CURRENT_USER;

  -- current_user proves SET LOCAL ROLE followed the token.
  CREATE FUNCTION rs_whoami() RETURNS text LANGUAGE sql AS $$ SELECT current_user::text $$;
  COMMENT ON FUNCTION rs_whoami() IS 'Executing role.
@expose: rpc';
  REVOKE EXECUTE ON FUNCTION rs_whoami() FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION rs_whoami() TO mcp_rs_viewer, mcp_rs_editor;

  -- Reads the published claims (proves the per-token claims plumbing).
  CREATE FUNCTION rs_claims() RETURNS text LANGUAGE sql STABLE
    AS $$ SELECT current_setting('request.jwt.claims', true) $$;
  COMMENT ON FUNCTION rs_claims() IS 'Published JWT claims.
@expose: rpc';
  REVOKE EXECUTE ON FUNCTION rs_claims() FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION rs_claims() TO mcp_rs_viewer, mcp_rs_editor;

  -- Granted to the editor only: the viewer's token must be denied by
  -- PostgreSQL itself (EXECUTE privilege), not by kozou.
  CREATE FUNCTION rs_editor_only() RETURNS text LANGUAGE sql AS $$ SELECT 'edited'::text $$;
  COMMENT ON FUNCTION rs_editor_only() IS 'Editor-only action.
@expose: rpc';
  REVOKE EXECUTE ON FUNCTION rs_editor_only() FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION rs_editor_only() TO mcp_rs_editor;
`;

describe('OAuth RS mode: per-token execution (real PostgreSQL)', () => {
  let db: DatabaseHandle;
  let pool: pkg.Pool;
  let handle: HttpServerHandle;
  const qn = (name: string): string => `${db.schema}.${name}`;

  beforeAll(async () => {
    db = await setupDatabase();
    const admin = new pkg.Client({ connectionString: db.connectionString });
    await admin.connect();
    try {
      await admin.query(`CREATE SCHEMA "${db.schema}"`);
      await admin.query(`SET search_path TO "${db.schema}"`);
      await admin.query(RS_FIXTURE_SQL);
      await admin.query(`GRANT USAGE ON SCHEMA "${db.schema}" TO mcp_rs_viewer, mcp_rs_editor`);
    } finally {
      await admin.end();
    }

    const cache = new SchemaCache({
      connection: db.connectionString,
      schemas: [db.schema],
      ttlMs: 60_000,
    });
    pool = new pkg.Pool({ connectionString: db.connectionString, max: 4 });
    const execution: McpExecution = { pool, claimsGuc: 'request.jwt.claims' };
    handle = await startHttpServer(cache, {
      port: 0,
      host: '127.0.0.1',
      execution,
      auth: {
        resource: RESOURCE,
        authorizationServers: ISSUERS,
        jwt: { secret: SECRET },
        allowedRoles: ['mcp_rs_viewer', 'mcp_rs_editor'],
      },
    });
  }, 120_000);

  afterAll(async () => {
    if (handle) await handle.close();
    if (pool) await pool.end();
    if (db) await db.cleanup();
  });

  async function callAs(
    role: string,
    fn: string,
  ): Promise<{ isError?: boolean; text: string }> {
    const token = await mint({ role, scope: 'mcp:describe mcp:execute' });
    const client = new Client({ name: 'httpauth-exec', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${handle.port}/mcp`),
      { requestInit: { headers: { authorization: `Bearer ${token}` } } },
    );
    await client.connect(transport);
    try {
      const result = (await client.callTool({
        name: 'call',
        arguments: { function: qn(fn) },
      })) as { isError?: boolean; content: { type: string; text: string }[] };
      return {
        ...(result.isError === undefined ? {} : { isError: result.isError }),
        text: result.content.map((c) => c.text).join(''),
      };
    } finally {
      await client.close();
    }
  }

  it("runs `call` as the token's role (SET LOCAL ROLE follows the token)", async () => {
    const viewer = await callAs('mcp_rs_viewer', 'rs_whoami');
    expect(viewer.isError).toBeUndefined();
    expect(JSON.parse(viewer.text)).toBe('mcp_rs_viewer');

    const editor = await callAs('mcp_rs_editor', 'rs_whoami');
    expect(JSON.parse(editor.text)).toBe('mcp_rs_editor');
  });

  it("publishes the token's claims for RLS (role + scope visible in the GUC)", async () => {
    const r = await callAs('mcp_rs_viewer', 'rs_claims');
    expect(r.isError).toBeUndefined();
    const claims = JSON.parse(JSON.parse(r.text) as string) as Record<string, unknown>;
    expect(claims.role).toBe('mcp_rs_viewer');
    expect(claims.scope).toBe('mcp:describe mcp:execute');
  });

  it("lets PostgreSQL deny a role without EXECUTE (generic message, no leak)", async () => {
    const denied = await callAs('mcp_rs_viewer', 'rs_editor_only');
    expect(denied.isError).toBe(true);
    expect(denied.text).toBe('Permission denied.');

    const allowed = await callAs('mcp_rs_editor', 'rs_editor_only');
    expect(allowed.isError).toBeUndefined();
    expect(JSON.parse(allowed.text)).toBe('edited');
  });
});
