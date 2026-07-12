// Real-IdP end-to-end: a real Keycloak (testcontainers) issues RS256 tokens
// per the bridge recipe, and the resource server verifies them via JWKS
// discovery and executes as the token's role against a real PostgreSQL.
//
// What only a real IdP can validate (the HS256 suites in httpAuth.test.ts
// already cover the challenge/gating matrix with self-minted tokens):
//   - RS256 signature verification against a live JWKS endpoint, with the
//     issuer bound to the advertised authorization server.
//   - The recipe's mapper co-location: audience and role claims live on the
//     mcp:* client scopes themselves, so a token minted WITHOUT those scopes
//     carries no audience — and is rejected — while a token minted with them
//     carries everything enforcement needs. Placing the role mapper anywhere
//     else silently breaks enforcement for dynamically-registered clients.
//   - A federated-first-time-user shape: an authenticated user with no role
//     attribute yields a token without a role claim, which this surface
//     rejects (no default role — role assignment stays an explicit IdP act).
//   - The loopback plaintext-http carve-out: issuer and resource are
//     127.0.0.1 http URLs, allowed without the insecure-transport opt-out.
//
// PostgreSQL roles are cluster-global and CI shares one cluster across the
// run, so the role names here are unique to this suite (kozou_kc_*).

import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pkg from 'pg';
import { request as httpRequest } from 'node:http';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import {
  setupDatabase,
  setupKeycloak,
  type DatabaseHandle,
  type KeycloakHandle,
} from '@kozou/test-utils';

import { SchemaCache, startHttpServer, type HttpServerHandle, type McpExecution } from '../src/index.js';

// The canonical resource URI is config-declared (never Host-derived), so it
// does not need to match the random listening port — but it MUST match the
// audience the realm's mcp:* scope mappers mint. Loopback http: allowed.
const RESOURCE = 'http://127.0.0.1:3999/mcp';
const REALM_FILE = fileURLToPath(new URL('./fixtures/keycloak-realm-e2e.json', import.meta.url));

const KC_FIXTURE_SQL = `
  CREATE ROLE kozou_kc_viewer NOLOGIN;
  CREATE ROLE kozou_kc_editor NOLOGIN;
  GRANT kozou_kc_viewer TO CURRENT_USER;
  GRANT kozou_kc_editor TO CURRENT_USER;

  -- current_user proves SET LOCAL ROLE followed the Keycloak token.
  CREATE FUNCTION kc_whoami() RETURNS text LANGUAGE sql AS $$ SELECT current_user::text $$;
  COMMENT ON FUNCTION kc_whoami() IS 'Executing role.
@expose: rpc';
  REVOKE EXECUTE ON FUNCTION kc_whoami() FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION kc_whoami() TO kozou_kc_viewer, kozou_kc_editor;

  -- Reads the published claims (proves the real token's claims reach RLS).
  CREATE FUNCTION kc_claims() RETURNS text LANGUAGE sql STABLE
    AS $$ SELECT current_setting('request.jwt.claims', true) $$;
  COMMENT ON FUNCTION kc_claims() IS 'Published JWT claims.
@expose: rpc';
  REVOKE EXECUTE ON FUNCTION kc_claims() FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION kc_claims() TO kozou_kc_viewer, kozou_kc_editor;
`;

describe('OAuth RS mode: real Keycloak end-to-end', () => {
  let kc: KeycloakHandle;
  let db: DatabaseHandle;
  let pool: pkg.Pool;
  let handle: HttpServerHandle;
  const qn = (name: string): string => `${db.schema}.${name}`;

  beforeAll(async () => {
    // The two containers are independent; start them concurrently. (In CI
    // the database resolves to the shared server without a container.)
    [kc, db] = await Promise.all([
      setupKeycloak({ realmFile: REALM_FILE, realm: 'kozou-e2e' }),
      setupDatabase(),
    ]);

    const admin = new pkg.Client({ connectionString: db.connectionString });
    await admin.connect();
    try {
      await admin.query(`CREATE SCHEMA "${db.schema}"`);
      await admin.query(`SET search_path TO "${db.schema}"`);
      await admin.query(KC_FIXTURE_SQL);
      await admin.query(`GRANT USAGE ON SCHEMA "${db.schema}" TO kozou_kc_viewer, kozou_kc_editor`);
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
        authorizationServers: [kc.issuerUrl],
        jwt: { jwksUri: kc.jwksUri },
        allowedRoles: ['kozou_kc_viewer', 'kozou_kc_editor'],
      },
    });
  }, 300_000);

  afterAll(async () => {
    if (handle) await handle.close();
    if (pool) await pool.end();
    if (db) await db.cleanup();
    if (kc) await kc.cleanup();
  });

  /** A real access token via the resource-owner password grant — the
   *  headless stand-in for the interactive authorization-code flow the
   *  hosted clients run; the minted token shape is the same. */
  async function token(username: string, scope: string): Promise<string> {
    const res = await fetch(kc.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: 'kozou-e2e-client',
        client_secret: 'kozou-e2e-client-secret',
        username,
        password: 'e2e-password',
        ...(scope === '' ? {} : { scope }),
      }),
    });
    const body = (await res.json()) as { access_token?: string; error?: string };
    if (res.status !== 200 || body.access_token === undefined) {
      throw new Error(`token grant for ${username} failed: ${res.status} ${JSON.stringify(body)}`);
    }
    return body.access_token;
  }

  /** Raw request against the resource server, keeping full header control. */
  function raw(
    opts: { method?: string; path?: string; headers?: Record<string, string>; body?: string } = {},
  ): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; json?: unknown }> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: handle.port,
          method: opts.method ?? 'GET',
          path: opts.path ?? '/',
          headers: opts.headers,
        },
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

  async function connect(accessToken: string, name: string): Promise<Client> {
    const client = new Client({ name, version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${handle.port}/mcp`),
      { requestInit: { headers: { authorization: `Bearer ${accessToken}` } } },
    );
    await client.connect(transport);
    return client;
  }

  async function callAs(
    username: string,
    fn: string,
  ): Promise<{ isError?: boolean; text: string }> {
    const client = await connect(await token(username, 'mcp:describe mcp:execute'), 'kc-e2e-exec');
    try {
      const result = (await client.callTool({
        name: 'call',
        arguments: { function: qn(fn) },
      })) as { isError?: boolean; content: { type: string; text: string }[] };
      return {
        ...(result.isError === undefined ? {} : { isError: result.isError }),
        text: result.content[0]?.text ?? '',
      };
    } finally {
      await client.close();
    }
  }

  it('advertises the real issuer in the protected-resource metadata', async () => {
    const res = await raw({ path: '/.well-known/oauth-protected-resource/mcp' });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      resource: RESOURCE,
      authorization_servers: [kc.issuerUrl],
      scopes_supported: ['mcp:describe', 'mcp:execute'],
      bearer_methods_supported: ['header'],
    });
  });

  it('challenges an unauthenticated request with the metadata pointer', async () => {
    const res = await raw({ method: 'POST', path: '/mcp' });
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toMatch(/resource_metadata=/);
  });

  it('runs `call` as the verified Keycloak token’s role (JWKS → SET LOCAL ROLE)', async () => {
    const viewer = await callAs('e2e-viewer', 'kc_whoami');
    expect(viewer.isError).toBeUndefined();
    expect(viewer.text).toContain('kozou_kc_viewer');

    const editor = await callAs('e2e-editor', 'kc_whoami');
    expect(editor.text).toContain('kozou_kc_editor');
  });

  it('publishes the real token’s claims for RLS (mapper-produced values)', async () => {
    const r = await callAs('e2e-viewer', 'kc_claims');
    expect(r.isError).toBeUndefined();
    // The claims GUC carries the verified token's payload: the recipe's
    // username mapper and the scope grant must both be visible to policies.
    expect(r.text).toContain('e2e-viewer');
    expect(r.text).toContain('mcp:execute');
  });

  it('a describe-scope token sees the describe tools but not `call`', async () => {
    const client = await connect(await token('e2e-viewer', 'mcp:describe'), 'kc-e2e-list');
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      expect(names).toContain('describe_functions');
      expect(names).not.toContain('call');
    } finally {
      await client.close();
    }
  });

  it('rejects an authenticated user without a role attribute (403 — D9, no default role)', async () => {
    const res = await raw({
      method: 'POST',
      path: '/mcp',
      headers: { authorization: `Bearer ${await token('e2e-norole', 'mcp:describe')}` },
    });
    expect(res.status).toBe(403);
  });

  it('rejects a role outside allowedRoles (403)', async () => {
    const res = await raw({
      method: 'POST',
      path: '/mcp',
      headers: { authorization: `Bearer ${await token('e2e-outsider', 'mcp:describe')}` },
    });
    expect(res.status).toBe(403);
  });

  it('rejects a token minted without the mcp:* scopes — no audience reaches it (401)', async () => {
    // The recipe puts the audience mapper ON the mcp:* scopes. A token from
    // the same client and user without those scopes therefore carries no
    // `aud` for this resource, and verification refuses it — misconfiguring
    // a client to skip the scopes fails closed rather than open.
    const res = await raw({
      method: 'POST',
      path: '/mcp',
      headers: { authorization: `Bearer ${await token('e2e-viewer', '')}` },
    });
    expect(res.status).toBe(401);
  });
});
