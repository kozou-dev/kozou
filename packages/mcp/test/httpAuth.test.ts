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

  // Advertise-vs-verify: the protected-resource metadata names an
  // authorization server and a resource URI; jwt.issuer / jwt.audience decide
  // what is actually honoured. Every consequence asserted below was measured
  // against the pinned jose — notably that `aud` is *intersected* with the
  // expected list, so a multi-audience token minted for the advertised
  // resource is accepted even when the expected list does not name it.
  const AS2 = 'https://as2.example.com/realms/kozou';
  const OTHER_AS = 'https://other.example.com/realms/kozou';
  const signals = (jwt: {
    secret: string;
    issuer?: string | string[];
    audience?: string | string[];
  }, over: Partial<typeof base> = {}) => {
    const auth = resolveMcpHttpAuth({ ...base, ...over, jwt }, '/mcp');
    return { divergences: auth.advertisementDivergences, notes: auth.advertisementNotes, auth };
  };

  it('says nothing when issuer and audience take their defaults', () => {
    for (const authorizationServers of [ISSUERS, [...ISSUERS, AS2]]) {
      const auth = resolveMcpHttpAuth({ ...base, authorizationServers }, '/mcp');
      expect(auth.advertisementDivergences).toEqual([]);
      expect(auth.advertisementNotes).toEqual([]);
    }
  });

  it('says nothing when explicit values restate what is advertised', () => {
    const { divergences, notes } = signals({
      secret: SECRET,
      issuer: ISSUERS[0],
      audience: RESOURCE,
    });
    expect(divergences).toEqual([]);
    expect(notes).toEqual([]);
  });

  it('warns in both directions when the accepted issuer is not the advertised one', () => {
    const { divergences, notes, auth } = signals({ secret: SECRET, issuer: OTHER_AS });
    // Full sentences, consequence clause included: the whole feature is what
    // these say, and a swap of the two consequences is the easiest wrong edit.
    expect(divergences).toEqual([
      `auth.jwt.issuer accepts "${OTHER_AS}", which auth.authorizationServers does not advertise: ` +
        `a token from an issuer this server never told its clients about is honoured.`,
      `auth.authorizationServers advertises "${ISSUERS[0]}", which auth.jwt.issuer does not ` +
        `accept: a token whose "iss" is exactly that is rejected. If that server mints a ` +
        `different spelling — a trailing slash is the usual one — advertise the form it issues.`,
    ]);
    expect(notes).toEqual([]);
    // Startup output, not a startup error: the escape hatch survives.
    expect(auth.authenticator).toBeDefined();
  });

  it('reports one bullet per mismatched value, in whichever direction it falls', () => {
    // Accepts everything advertised, plus one nobody was told about.
    expect(signals({ secret: SECRET, issuer: [ISSUERS[0], OTHER_AS] }).divergences).toEqual([
      expect.stringContaining(`auth.jwt.issuer accepts "${OTHER_AS}"`),
    ]);
    // Advertises two, accepts one: a client sent to the other is refused. Two
    // unaccepted entries produce two bullets — no "that server(s)" agreement
    // to get wrong.
    const partial = signals({ secret: SECRET, issuer: ISSUERS[0] }, {
      authorizationServers: [...ISSUERS, AS2, 'https://as3.example.com/realms/kozou'],
    });
    expect(partial.divergences).toEqual([
      expect.stringContaining(`auth.authorizationServers advertises "${AS2}"`),
      expect.stringContaining('auth.authorizationServers advertises "https://as3.example.com'),
    ]);
  });

  it('states what an empty string really does: no comparison, but the claim is now mandatory', () => {
    // Measured, and the trap in it: jose gates the *presence* check on the
    // option being defined and the *value* check on it being truthy. So ''
    // is not "no check" — it is stricter than omitting the option (a token
    // with no `iss` at all is rejected) and weaker than naming an issuer.
    // Saying "no check runs" would be a false promise about kozou's own
    // service tokens, which carry no `iss` unless one is configured.
    expect(signals({ secret: SECRET, issuer: '' }).divergences).toEqual([
      'auth.jwt.issuer is an empty string: every "iss" value is accepted, and a token carrying ' +
        'no "iss" claim at all is rejected. That is stricter than leaving the option out and ' +
        'weaker than naming an issuer — almost certainly not what was meant.',
    ]);
    expect(signals({ secret: SECRET, audience: '' }).divergences).toEqual([
      'auth.jwt.audience is an empty string: a token minted for any resource is accepted here, ' +
        'and one carrying no "aud" claim at all is rejected. That is stricter than leaving the ' +
        'option out and weaker than naming an audience — almost certainly not what was meant.',
    ]);
  });

  it('distinguishes an empty list from a list of empty strings, on both claims', () => {
    // Full sentences: the two branches differ only in why nothing matches,
    // and both end in the same clause, so a substring assertion would let
    // them be swapped. `audience: []` reaches this from a plain config file
    // — the CLI schema's array branch has no .min(1).
    expect(signals({ secret: SECRET, issuer: [] }).divergences).toEqual([
      'auth.jwt.issuer is an empty list, which no "iss" can match: every request is rejected, ' +
        'whichever authorization server the client went to.',
    ]);
    expect(signals({ secret: SECRET, audience: [] }).divergences).toEqual([
      'auth.jwt.audience is an empty list, which no "aud" can match: every request is rejected.',
    ]);
    expect(signals({ secret: SECRET, issuer: [''] }).divergences).toEqual([
      'auth.jwt.issuer lists nothing but empty strings, which only a literally empty "iss" ' +
        'claim matches: no token an authorization server would mint is accepted.',
    ]);
    // Measured: audience [''] rejects a token minted for the advertised
    // resource. Before this it was classified as the documented escape hatch
    // and announced as a supported shape.
    const emptyEntry = signals({ secret: SECRET, audience: [''] });
    expect(emptyEntry.notes).toEqual([]);
    expect(emptyEntry.divergences).toEqual([
      'auth.jwt.audience lists nothing but empty strings, which only a literally empty "aud" ' +
        'claim matches: no token an authorization server would mint is accepted.',
    ]);
  });

  it('does not repeat itself when a config list repeats a value', () => {
    // Both config lists accept duplicates, and one bullet per value turned a
    // duplicated entry into a duplicated paragraph on stderr.
    expect(signals({ secret: SECRET, issuer: [OTHER_AS, OTHER_AS] }).divergences).toHaveLength(2);
    expect(
      signals({ secret: SECRET, issuer: OTHER_AS }, { authorizationServers: [...ISSUERS, ...ISSUERS] })
        .divergences,
    ).toEqual([
      expect.stringContaining(`auth.jwt.issuer accepts "${OTHER_AS}"`),
      expect.stringContaining(`auth.authorizationServers advertises "${ISSUERS[0]}"`),
    ]);
    expect(
      signals({ secret: SECRET, audience: [RESOURCE, 'x', 'x'] }).divergences,
    ).toHaveLength(1);
  });

  it('treats the documented audience escape hatch as a note, not a warning', () => {
    // The operator guide tells anyone whose IdP cannot mint the resource URI
    // as `aud` to set jwt.audience to what it does issue. That deployment
    // must not boot into a permanent WARNING, so it is a note — and the note
    // states the real consequence, which depends on jose intersecting the
    // lists rather than comparing them whole.
    const { divergences, notes } = signals({ secret: SECRET, audience: 'kozou-rest-client-id' });
    expect(divergences).toEqual([]);
    expect(notes).toEqual([
      `auth.jwt.audience expects "kozou-rest-client-id", not the advertised auth.resource ` +
        `"${RESOURCE}": a token carrying any of those audiences is accepted, which is what the ` +
        `setting is for. A token whose only audience is the advertised resource is rejected; one ` +
        `carrying both passes, because the two lists are intersected rather than compared whole.`,
    ]);
  });

  it('the escape-hatch note leads with the shape that deployment actually mints', () => {
    // Measured: with audience "rest-id", a token whose *only* audience is
    // "rest-id" — no resource URI anywhere — is accepted. That is the normal
    // case, since the whole premise is an IdP that cannot mint the resource
    // URI. A note that mentions only the both-audiences token reads as "your
    // IdP must mint both", which is the opposite of why the option was set.
    const [note] = signals({ secret: SECRET, audience: ['a', 'b'] }).notes;
    expect(note).toContain('a token carrying any of those audiences is accepted');
    // ...and it must not be phrased as "both", which is wrong for two values.
    expect(note).toContain('"a", "b"');
    expect(note).not.toMatch(/carrying both is accepted/);
  });

  it('warns when the accepted audience reaches beyond the advertised resource', () => {
    // Not the escape hatch: this endpoint honours a token minted for another
    // resource, which is the confused-deputy case the audience binding exists
    // to prevent. Measured: with audience [resource, "other"], a token whose
    // only `aud` is "other" is accepted.
    const { divergences, notes } = signals({
      secret: SECRET,
      audience: [RESOURCE, 'https://legacy.example.com/mcp'],
    });
    expect(divergences).toEqual([
      `auth.jwt.audience accepts "https://legacy.example.com/mcp" as well as the advertised ` +
        `auth.resource: a token minted for "https://legacy.example.com/mcp" is honoured here, ` +
        `so this endpoint answers for a resource it does not advertise.`,
    ]);
    expect(notes).toEqual([]);
  });

  it('reports a divergence and a note together when both apply', () => {
    // The two channels are independent: an escape-hatch audience does not
    // suppress an issuer problem, and an issuer problem does not swallow the
    // note the operator boots with every day.
    const { divergences, notes } = signals({
      secret: SECRET,
      issuer: OTHER_AS,
      audience: 'kozou-rest-client-id',
    });
    expect(divergences).toHaveLength(2);
    expect(notes).toHaveLength(1);
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
      auth: {
        resource: RESOURCE,
        authorizationServers: ISSUERS,
        jwt: { secret: SECRET },
        allowedRoles: ['mcp_rs_viewer'],
      },
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
    expect(names).toContain('search_schema');
    expect(names).not.toContain('call');
    expect(names).toHaveLength(8);
  });

  it('an execute-only token sees only `call`', async () => {
    expect(await listToolNames('mcp:execute')).toEqual(['call']);
  });

  it('a token with both scopes sees everything', async () => {
    expect(await listToolNames('mcp:describe mcp:execute')).toHaveLength(9);
  });
});

// B1 enforced at this layer too: a direct embedder never passes through the
// kozou CLI config validation, so OAuth + execution without an explicit role
// allowlist must be a startup error here as well — on both public entry
// points (startHttpServer and createMcpServer), with a dispatch-level check
// backing the declared allowlist for any foreign transport wiring.
describe('OAuth RS mode: execution requires a role allowlist', () => {
  const deadPool = {
    connect: () => Promise.reject(new Error('the pool must never be dialed')),
  } as unknown as ConnectionPool;
  const SCOPES = { describe: 'mcp:describe', execute: 'mcp:execute' };
  const RAW: RawIntrospection = {
    serverVersion: '16.2',
    introspectedAt: '2026-01-01T00:00:00.000Z',
    schemas: ['public'],
    enums: [],
    functions: [],
    tables: [],
    views: [],
  };

  it('startHttpServer rejects OAuth + execution without a non-empty allowedRoles', async () => {
    const cache = new SchemaCache({ connection: 'postgres://invalid:5432/none' });
    for (const allowedRoles of [undefined, [] as string[]]) {
      await expect(
        startHttpServer(cache, {
          port: 0,
          host: '127.0.0.1',
          execution: { pool: deadPool, claimsGuc: 'request.jwt.claims' },
          auth: {
            resource: RESOURCE,
            authorizationServers: ISSUERS,
            jwt: { secret: SECRET },
            ...(allowedRoles === undefined ? {} : { allowedRoles }),
          },
        }),
      ).rejects.toThrow(/non-empty auth\.allowedRoles/);
    }
  });

  it('createMcpServer rejects a scope gate + execution without a non-empty allowedRoles', () => {
    const cache = new SchemaCache({ connection: 'postgres://invalid:5432/none' });
    const execution = { pool: deadPool, claimsGuc: 'request.jwt.claims' };
    for (const allowedRoles of [undefined, [] as string[]]) {
      expect(() => createMcpServer(cache, execution, SCOPES, allowedRoles)).toThrow(
        /non-empty allowedRoles/,
      );
    }
    // Describe-only (no execution) and no-auth (no scopes) stay unaffected.
    expect(() => createMcpServer(cache, undefined, SCOPES)).not.toThrow();
    expect(() => createMcpServer(cache, execution)).not.toThrow();
  });

  it('a verified role outside the allowlist is refused at dispatch', async () => {
    const ctx = await buildSchemaContext({ raw: RAW });
    const cache = { get: () => Promise.resolve(ctx), invalidate: () => {} } as unknown as SchemaCache;
    const server = createMcpServer(
      cache,
      { pool: deadPool, claimsGuc: 'request.jwt.claims' },
      SCOPES,
      ['app_viewer'],
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    try {
      const response = new Promise<unknown>((resolve) => {
        clientTransport.onmessage = (m) => resolve(m);
      });
      // Raw JSON-RPC send: only a transport can attach auth info, and this is
      // exactly the foreign-wiring shape the dispatch check exists to cover.
      await clientTransport.send(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'call', arguments: { function: 'public.rs_whoami' } },
        },
        {
          authInfo: {
            token: 'opaque-not-used',
            clientId: 'test-client',
            scopes: ['mcp:execute'],
            extra: { role: 'not_on_the_list', claims: {} },
          },
        },
      );
      const msg = (await response) as {
        result?: { isError?: boolean; content: { text: string }[] };
      };
      expect(msg.result?.isError).toBe(true);
      expect(msg.result?.content[0]?.text).toMatch(/role is not allowed/);
    } finally {
      await clientTransport.close();
    }
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
