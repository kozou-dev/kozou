import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { loadConfig, type KozouConfig } from '../src/config.js';
import {
  buildAdminUiEnv,
  classifyAdminUiExposure,
  describeApiAuth,
  resolveDevPrivilegeRole,
  resolveOrigin,
  resolveAdminUiEntry,
  resolveAdminUiToken,
  type ServiceTokenMinter,
} from '../src/commands/dev-runtime.js';

async function makeConfig(
  overrides: { env?: NodeJS.ProcessEnv } = {},
): Promise<KozouConfig> {
  // skipFile keeps this hermetic: defaults + DATABASE_URL only.
  return loadConfig({
    skipFile: true,
    env: { DATABASE_URL: 'postgres://u:p@db:5432/app', ...overrides.env },
  });
}

describe('resolveOrigin', () => {
  it('defaults to localhost on the configured UI port', async () => {
    const config = await makeConfig();
    expect(resolveOrigin(config, {})).toBe('http://localhost:3333');
  });

  it('prefers an explicit ORIGIN env', async () => {
    const config = await makeConfig();
    expect(resolveOrigin(config, { ORIGIN: 'https://admin.example.com' })).toBe(
      'https://admin.example.com',
    );
  });

  it('falls back to KOZOU_ORIGIN when ORIGIN is unset', async () => {
    const config = await makeConfig();
    expect(resolveOrigin(config, { KOZOU_ORIGIN: 'http://10.0.0.5:3333' })).toBe(
      'http://10.0.0.5:3333',
    );
  });

  it('tracks a non-default UI port', async () => {
    // The config file path is skipped, so override the port by parsing a
    // tiny inline config via env expansion is not available; instead
    // assert the default-port behaviour is port-derived by mutating.
    const config = await makeConfig();
    const custom: KozouConfig = {
      ...config,
      server: { ...config.server, ui: { ...config.server.ui, port: 8080 } },
    };
    expect(resolveOrigin(custom, {})).toBe('http://localhost:8080');
  });
});

describe('buildAdminUiEnv', () => {
  it('maps config + origin into the adapter-node server env', async () => {
    const config = await makeConfig();
    const env = buildAdminUiEnv(config, 'http://localhost:3333', { PATH: '/usr/bin' });
    expect(env).toMatchObject({
      PATH: '/usr/bin', // base env preserved
      DATABASE_URL: 'postgres://u:p@db:5432/app',
      // The data-adapter URL flows straight from config (default host).
      KOZOU_ADAPTER_URL: config.adapter.url,
      PORT: '3333',
      // The Admin UI binds the configured host — loopback by default.
      HOST: '127.0.0.1',
      ORIGIN: 'http://localhost:3333',
      NODE_ENV: 'production',
      // The co-located MCP HTTP server's port, for the "Connect an AI agent" page.
      KOZOU_MCP_HTTP_PORT: '3334',
    });
  });

  it('forwards a custom MCP HTTP port to the UI child', async () => {
    const config = await makeConfig();
    const custom: KozouConfig = {
      ...config,
      server: {
        ...config.server,
        mcp: {
          ...config.server.mcp,
          http: { enabled: true, port: 9999, host: '127.0.0.1' },
        },
      },
    };
    const env = buildAdminUiEnv(custom, 'http://localhost:3333', {});
    expect(env.KOZOU_MCP_HTTP_PORT).toBe('9999');
    // The endpoint is on, so nothing tells the UI to hide the connection page.
    expect(env.KOZOU_UI_MCP_LINK).toBeUndefined();
  });

  it('tells the UI the MCP endpoint is off, and drops the port', async () => {
    const config = await makeConfig();
    const custom: KozouConfig = {
      ...config,
      server: {
        ...config.server,
        mcp: {
          ...config.server.mcp,
          http: { enabled: false, port: 3334, host: '127.0.0.1' },
        },
      },
    };
    const env = buildAdminUiEnv(custom, 'http://localhost:3333', {});
    // Explicit, not by omission: the page falls back to the default port when
    // none is passed, so an absent port alone would leave it advertising 3334
    // with nothing listening.
    expect(env.KOZOU_UI_MCP_LINK).toBe('off');
    expect(env.KOZOU_MCP_HTTP_PORT).toBeUndefined();
  });

  it('clears a stray inherited KOZOU_UI_MCP_LINK when the endpoint is on', async () => {
    const config = await makeConfig();
    // A parent environment claiming the endpoint is off must not hide a
    // connection page for an endpoint this runtime is in fact serving.
    const env = buildAdminUiEnv(config, 'http://localhost:3333', {
      KOZOU_UI_MCP_LINK: 'off',
    });
    expect(env.KOZOU_UI_MCP_LINK).toBeUndefined();
    expect(env.KOZOU_MCP_HTTP_PORT).toBe('3334');
  });

  it('carries the configured adapter url and UI host/port', async () => {
    const config = await makeConfig();
    const adapterUrl = 'http://rest-adapter:3000';
    const custom: KozouConfig = {
      ...config,
      adapter: { ...config.adapter, url: adapterUrl },
      server: {
        ...config.server,
        ui: { port: 4000, host: '127.0.0.1' },
      },
    };
    const env = buildAdminUiEnv(custom, 'http://localhost:4000', {});
    expect(env.KOZOU_ADAPTER_URL).toBe(adapterUrl);
    expect(env.PORT).toBe('4000');
    expect(env.HOST).toBe('127.0.0.1');
  });

  it('never passes KOZOU_JWT_* verifier inputs to the UI child', async () => {
    // The scaffold compose forwards KOZOU_JWT_* to the CLI process; the
    // network-facing UI child only consumes KOZOU_ADAPTER_*, so signing /
    // verification material must not extend into it.
    const config = await makeConfig();
    const baseEnv = {
      PATH: '/usr/bin',
      KOZOU_JWT_SECRET: 'hs256-secret',
      KOZOU_JWT_PUBLIC_KEY: 'pem',
      KOZOU_JWT_JWKS_URI: 'https://idp.example/jwks',
      KOZOU_JWT_ANON_ROLE: 'web_anon',
      KOZOU_UI_ROLE: 'app_admin',
      KOZOU_UI_CLAIMS: '{"tenant_id":"acme"}',
    };
    // In-house api path (token attached) and REST opt-out path alike.
    const apiEnv = buildAdminUiEnv(config, 'http://localhost:3333', baseEnv, 'http://127.0.0.1:3335', 'tok');
    const optOutEnv = buildAdminUiEnv(config, 'http://localhost:3333', baseEnv);
    for (const env of [apiEnv, optOutEnv]) {
      expect(Object.keys(env).filter((k) => k.startsWith('KOZOU_JWT_'))).toEqual([]);
      // The UI token-mint inputs stay in the CLI process too (claim values
      // can carry tenant identifiers).
      expect(env.KOZOU_UI_ROLE).toBeUndefined();
      expect(env.KOZOU_UI_CLAIMS).toBeUndefined();
      expect(env.PATH).toBe('/usr/bin');
    }
    expect(apiEnv.KOZOU_ADAPTER_TOKEN).toBe('tok');
  });

  it('omits KOZOU_ADAPTER_KIND and uses the config url for the REST opt-out', async () => {
    // No apiAdapterUrl -> the external REST opt-out: the UI falls back to its
    // REST adapter (KOZOU_ADAPTER_KIND unset) and reaches it at the config url.
    const config = await makeConfig();
    const env = buildAdminUiEnv(config, 'http://localhost:3333', {});
    expect(env.KOZOU_ADAPTER_KIND).toBeUndefined();
    expect(env.KOZOU_ADAPTER_URL).toBe(config.adapter.url);
  });

  it('wires the in-house @kozou/api backend when an api url is given', async () => {
    const config = await makeConfig();
    const env = buildAdminUiEnv(
      config,
      'http://localhost:3333',
      {},
      'http://127.0.0.1:3335',
    );
    expect(env.KOZOU_ADAPTER_KIND).toBe('api');
    expect(env.KOZOU_ADAPTER_URL).toBe('http://127.0.0.1:3335');
  });

  it('exposes the api token as KOZOU_ADAPTER_TOKEN on the api path', async () => {
    const config = await makeConfig();
    const env = buildAdminUiEnv(config, 'http://localhost:3333', {}, 'http://127.0.0.1:3335', 'tok');
    expect(env.KOZOU_ADAPTER_TOKEN).toBe('tok');
  });

  it('clears an inherited KOZOU_ADAPTER_TOKEN when no api token is resolved', async () => {
    const config = await makeConfig();
    const env = buildAdminUiEnv(
      config,
      'http://localhost:3333',
      { KOZOU_ADAPTER_TOKEN: 'stale' },
      'http://127.0.0.1:3335',
    );
    expect(env.KOZOU_ADAPTER_TOKEN).toBeUndefined();
  });

  it('clears a stale KOZOU_ADAPTER_TOKEN on the REST opt-out path', async () => {
    const config = await makeConfig();
    const env = buildAdminUiEnv(config, 'http://localhost:3333', { KOZOU_ADAPTER_TOKEN: 'x' });
    expect(env.KOZOU_ADAPTER_TOKEN).toBeUndefined();
  });

  it('clears an inherited KOZOU_ADAPTER_KIND=api so the opt-out stays authoritative', async () => {
    // A stray parent KOZOU_ADAPTER_KIND must not flip the UI onto the api
    // adapter when the user selected the external REST opt-out.
    const config = await makeConfig();
    const env = buildAdminUiEnv(config, 'http://localhost:3333', { KOZOU_ADAPTER_KIND: 'api' });
    expect(env.KOZOU_ADAPTER_KIND).toBeUndefined();
    expect(env.KOZOU_ADAPTER_URL).toBe(config.adapter.url);
  });

  it('forwards api.rpc allowlists to the UI on the api path (issue #103)', async () => {
    const base = await makeConfig();
    const config: KozouConfig = {
      ...base,
      api: { rpc: { allowDefiner: ['public.approve'], allowPublicExecute: ['public.search'] } },
    };
    const env = buildAdminUiEnv(config, 'http://localhost:3333', {}, 'http://127.0.0.1:3335');
    expect(env.KOZOU_RPC_ALLOW_DEFINER).toBe('public.approve');
    expect(env.KOZOU_RPC_ALLOW_PUBLIC_EXECUTE).toBe('public.search');
  });

  it('clears inherited RPC allowlists on the REST opt-out path (no widening)', async () => {
    // A stray parent KOZOU_RPC_ALLOW_* must not list functions on the opt-out
    // path (where the Actions surface is hidden anyway).
    const config = await makeConfig();
    const env = buildAdminUiEnv(config, 'http://localhost:3333', {
      KOZOU_RPC_ALLOW_DEFINER: 'public.evil',
      KOZOU_RPC_ALLOW_PUBLIC_EXECUTE: 'public.evil',
    });
    expect(env.KOZOU_RPC_ALLOW_DEFINER).toBeUndefined();
    expect(env.KOZOU_RPC_ALLOW_PUBLIC_EXECUTE).toBeUndefined();
  });
});

describe('resolveAdminUiToken', () => {
  function spyMinter(): {
    calls: Array<Parameters<ServiceTokenMinter['signServiceToken']>[0]>;
    minter: ServiceTokenMinter;
  } {
    const calls: Array<Parameters<ServiceTokenMinter['signServiceToken']>[0]> = [];
    return {
      calls,
      minter: {
        signServiceToken: (opts) => {
          calls.push(opts);
          return Promise.resolve('minted-token');
        },
      },
    };
  }

  async function configWithAuth(auth: KozouConfig['auth']): Promise<KozouConfig> {
    return { ...(await makeConfig()), auth };
  }

  it('returns no token and no warning when auth is absent', async () => {
    const { minter, calls } = spyMinter();
    const result = await resolveAdminUiToken(await makeConfig(), minter, {});
    expect(result).toEqual({});
    expect(calls).toHaveLength(0);
  });

  it('passes a supplied auth.ui.token through without minting', async () => {
    const { minter, calls } = spyMinter();
    const config = await configWithAuth({ jwt: { secret: 's' }, ui: { token: 'supplied' } });
    const result = await resolveAdminUiToken(config, minter, {});
    expect(result.token).toBe('supplied');
    expect(calls).toHaveLength(0);
  });

  it('passes a KOZOU_ADAPTER_TOKEN env token through without minting', async () => {
    const { minter, calls } = spyMinter();
    const config = await configWithAuth({ jwt: { publicKey: '-----BEGIN PUBLIC KEY-----' } });
    const result = await resolveAdminUiToken(config, minter, { KOZOU_ADAPTER_TOKEN: 'env-tok' });
    expect(result.token).toBe('env-tok');
    expect(calls).toHaveLength(0);
  });

  it('mints an HS256 token claiming auth.ui.role, passing roleClaim/iss/aud', async () => {
    const { minter, calls } = spyMinter();
    const config = await configWithAuth({
      jwt: { secret: 's', issuer: 'kozou', audience: 'api' },
      roleClaim: 'kozou_role',
      allowedRoles: ['app_admin'],
      ui: { role: 'app_admin' },
    });
    const result = await resolveAdminUiToken(config, minter, {});
    expect(result.token).toBe('minted-token');
    expect(result.warning).toBeUndefined();
    expect(calls[0]).toEqual({
      secret: 's',
      roleClaim: 'kozou_role',
      role: 'app_admin',
      issuer: 'kozou',
      audience: 'api',
    });
  });

  it('mints without a role (defaultRole applies) and warns on neither role nor default', async () => {
    const { minter, calls } = spyMinter();
    const config = await configWithAuth({ jwt: { secret: 's' } });
    const result = await resolveAdminUiToken(config, minter, {});
    expect(result.token).toBe('minted-token');
    expect(calls[0].role).toBeUndefined();
    expect(result.warning).toMatch(/auth\.ui\.role/);
  });

  it('mints with no warning when no ui.role but a defaultRole is set', async () => {
    const { minter } = spyMinter();
    const config = await configWithAuth({ jwt: { secret: 's' }, defaultRole: 'app_reader' });
    const result = await resolveAdminUiToken(config, minter, {});
    expect(result.token).toBe('minted-token');
    expect(result.warning).toBeUndefined();
  });

  it('warns when the minted role is not in allowedRoles', async () => {
    const { minter } = spyMinter();
    const config = await configWithAuth({
      jwt: { secret: 's' },
      allowedRoles: ['app_reader'],
      ui: { role: 'app_admin' },
    });
    const result = await resolveAdminUiToken(config, minter, {});
    expect(result.token).toBe('minted-token');
    expect(result.warning).toMatch(/allowedRoles/);
  });

  it('passes auth.ui.claims through to the minter', async () => {
    const { minter, calls } = spyMinter();
    const config = await configWithAuth({
      jwt: { secret: 's' },
      defaultRole: 'app_reader',
      ui: { claims: { tenant_id: 'acme', is_admin: true } },
    });
    const result = await resolveAdminUiToken(config, minter, {});
    expect(result.token).toBe('minted-token');
    expect(result.warning).toBeUndefined();
    expect(calls[0]!.claims).toEqual({ tenant_id: 'acme', is_admin: true });
  });

  it('warns when a claims key is reserved (role claim / iat / configured iss, aud)', async () => {
    const { minter } = spyMinter();
    const config = await configWithAuth({
      jwt: { secret: 's', issuer: 'kozou' },
      ui: { role: 'app_admin', claims: { role: 'smuggled', iat: 1, iss: 'forged', tenant_id: 't' } },
    });
    const result = await resolveAdminUiToken(config, minter, {});
    expect(result.token).toBe('minted-token');
    expect(result.warning).toMatch(/reserved/);
    expect(result.warning).toContain('"role"');
    expect(result.warning).toContain('"iat"');
    expect(result.warning).toContain('"iss"');
    expect(result.warning).not.toContain('"tenant_id"');
    // A collision alone does not make the token rejected.
    expect(result.knownRejected).toBeUndefined();
  });

  it('does not flag iss/aud claims when the auth config sets no issuer/audience', async () => {
    const { minter } = spyMinter();
    const config = await configWithAuth({
      jwt: { secret: 's' },
      ui: { role: 'app_admin', claims: { iss: 'mine', aud: 'mine' } },
    });
    const result = await resolveAdminUiToken(config, minter, {});
    expect(result.warning).toBeUndefined();
  });

  it('uses the custom roleClaim when checking for a reserved collision', async () => {
    const { minter } = spyMinter();
    const config = await configWithAuth({
      jwt: { secret: 's' },
      roleClaim: 'kozou_role',
      ui: { role: 'app_admin', claims: { kozou_role: 'smuggled' } },
    });
    const result = await resolveAdminUiToken(config, minter, {});
    expect(result.warning).toContain('"kozou_role"');
  });

  it('joins a reserved-claims warning with a minted-role warning (still knownRejected)', async () => {
    const { minter } = spyMinter();
    // No ui.role and no defaultRole -> known 403; plus a reserved claims key.
    const config = await configWithAuth({
      jwt: { secret: 's' },
      ui: { claims: { iat: 1 } },
    });
    const result = await resolveAdminUiToken(config, minter, {});
    expect(result.warning).toMatch(/reserved/);
    expect(result.warning).toMatch(/auth\.ui\.role/);
    expect(result.knownRejected).toBe(true);
  });

  it('flags an already-expired exp claim as known-rejected', async () => {
    const { minter } = spyMinter();
    const config = await configWithAuth({
      jwt: { secret: 's' },
      ui: { role: 'app_admin', claims: { exp: 1 } },
    });
    const result = await resolveAdminUiToken(config, minter, {});
    expect(result.warning).toMatch(/exp is already in the past/);
    expect(result.knownRejected).toBe(true);
  });

  it('flags a future nbf claim as known-rejected', async () => {
    const { minter } = spyMinter();
    const config = await configWithAuth({
      jwt: { secret: 's' },
      ui: { role: 'app_admin', claims: { nbf: Math.floor(Date.now() / 1000) + 3600 } },
    });
    const result = await resolveAdminUiToken(config, minter, {});
    expect(result.warning).toMatch(/nbf is in the future/);
    expect(result.knownRejected).toBe(true);
  });

  it('flags non-numeric temporal claims as known-rejected', async () => {
    const { minter } = spyMinter();
    const config = await configWithAuth({
      jwt: { secret: 's' },
      ui: { role: 'app_admin', claims: { exp: 'tomorrow' } },
    });
    const result = await resolveAdminUiToken(config, minter, {});
    expect(result.warning).toMatch(/exp is not a finite number/);
    expect(result.knownRejected).toBe(true);
  });

  it('flags non-finite temporal claims (YAML .nan / .inf) as known-rejected', async () => {
    // YAML parses `.nan` / `.inf` to NaN / Infinity, which pass a typeof
    // check, serialize to null in the JWT payload, and fail verification.
    const { minter } = spyMinter();
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const config = await configWithAuth({
        jwt: { secret: 's' },
        ui: { role: 'app_admin', claims: { exp: bad } },
      });
      const result = await resolveAdminUiToken(config, minter, {});
      expect(result.warning).toMatch(/exp is not a finite number/);
      expect(result.knownRejected).toBe(true);
    }
    const config = await configWithAuth({
      jwt: { secret: 's' },
      ui: { role: 'app_admin', claims: { nbf: Number.NaN } },
    });
    const result = await resolveAdminUiToken(config, minter, {});
    expect(result.warning).toMatch(/nbf is not a finite number/);
    expect(result.knownRejected).toBe(true);
  });

  it('allows a well-formed future exp (an intentionally expiring UI token)', async () => {
    const { minter } = spyMinter();
    const config = await configWithAuth({
      jwt: { secret: 's' },
      ui: { role: 'app_admin', claims: { exp: Math.floor(Date.now() / 1000) + 3600 } },
    });
    const result = await resolveAdminUiToken(config, minter, {});
    expect(result.warning).toBeUndefined();
    expect(result.knownRejected).toBeUndefined();
  });

  it('warns that claims are ignored when a ready-made token is supplied', async () => {
    const { minter, calls } = spyMinter();
    const config = await configWithAuth({
      jwt: { secret: 's' },
      ui: { token: 'ready-made', claims: { tenant_id: 'acme' } },
    });
    const result = await resolveAdminUiToken(config, minter, {});
    expect(result.token).toBe('ready-made');
    expect(result.warning).toMatch(/claims is ignored/);
    expect(calls).toHaveLength(0);
  });

  it('mentions unusable claims in the RS256 no-token warning', async () => {
    const { minter } = spyMinter();
    const config = await configWithAuth({
      jwt: { publicKey: '-----BEGIN PUBLIC KEY-----' },
      ui: { claims: { tenant_id: 'acme' } },
    });
    const result = await resolveAdminUiToken(config, minter, {});
    expect(result.token).toBeUndefined();
    expect(result.warning).toMatch(/claims is also unusable/);
  });

  it('returns a warning and no token for RS256 with no supplied token', async () => {
    const { minter, calls } = spyMinter();
    const config = await configWithAuth({ jwt: { publicKey: '-----BEGIN PUBLIC KEY-----' } });
    const result = await resolveAdminUiToken(config, minter, {});
    expect(result.token).toBeUndefined();
    expect(result.warning).toMatch(/RS256/);
    expect(calls).toHaveLength(0);
  });
});

describe('describeApiAuth', () => {
  it('says disabled when no auth is configured', () => {
    expect(describeApiAuth(undefined)).toBe(
      'disabled (no JWT verification configured; requests run as the connection role)',
    );
  });

  it('describes an HS256 setup without leaking the secret', () => {
    const line = describeApiAuth({
      jwt: { secret: 'super-secret' },
      allowedRoles: ['app_user', 'web_anon'],
      defaultRole: 'app_user',
      anonRole: 'web_anon',
      ui: { role: 'app_admin' },
    });
    expect(line).toBe(
      'HS256 (shared secret), allowedRoles=[app_user, web_anon], ' +
        'defaultRole=app_user, anonRole=web_anon, ui role=app_admin',
    );
    expect(line).not.toContain('super-secret');
  });

  it('names the JWKS endpoint and a supplied UI token', () => {
    const line = describeApiAuth({
      jwt: { jwksUri: 'https://idp.example/.well-known/jwks.json' },
      ui: { token: 'opaque.jwt.token' },
    });
    expect(line).toBe('JWKS (https://idp.example/.well-known/jwks.json), ui token=supplied');
    expect(line).not.toContain('opaque.jwt.token');
  });

  it('describes a static public key', () => {
    expect(describeApiAuth({ jwt: { publicKey: '-----BEGIN PUBLIC KEY-----' } })).toBe(
      'static public key',
    );
  });

  it('lists ui claims by key only — never values', () => {
    const line = describeApiAuth({
      jwt: { secret: 's' },
      ui: { role: 'app_admin', claims: { tenant_id: 'secret-tenant', is_admin: true } },
    });
    expect(line).toBe('HS256 (shared secret), ui role=app_admin, ui claims=[tenant_id, is_admin]');
    expect(line).not.toContain('secret-tenant');
  });

  it('redacts credentials embedded in the JWKS URL', () => {
    const line = describeApiAuth({
      jwt: { jwksUri: 'https://user:hunter2@idp.example/jwks?token=tok-123#frag' },
    });
    expect(line).toBe('JWKS (https://idp.example/jwks)');
    expect(line).not.toContain('hunter2');
    expect(line).not.toContain('tok-123');
  });
});

describe('classifyAdminUiExposure', () => {
  const hs256 = { jwt: { secret: 's' } };

  it('is unauthenticated with no auth or with an external adapter', () => {
    expect(classifyAdminUiExposure(undefined, undefined, true)).toBe('unauthenticated');
    // External REST opt-out: kozou does not manage that adapter's auth.
    expect(classifyAdminUiExposure(hs256, { token: 'tok' }, false)).toBe('unauthenticated');
  });

  it('is service-token when a usable UI token was resolved', () => {
    expect(classifyAdminUiExposure(hs256, { token: 'tok' }, true)).toBe('service-token');
  });

  it('is anon-role when no token resolved but an anonRole is configured', () => {
    expect(classifyAdminUiExposure({ ...hs256, anonRole: 'web_anon' }, undefined, true)).toBe(
      'anon-role',
    );
  });

  it('is rejected when no token resolved and no anonRole', () => {
    // RS256 / JWKS with no supplied token: the CLI cannot mint one.
    const rs256 = { jwt: { jwksUri: 'https://idp.example/jwks' } };
    expect(classifyAdminUiExposure(rs256, { warning: 'no token' }, true)).toBe('rejected');
    expect(classifyAdminUiExposure(hs256, { token: '' }, true)).toBe('rejected');
  });

  it('is rejected (not service-token) when the resolver knows the API will refuse the token', () => {
    // HS256 mints a token even when it is known-rejected: no role and no
    // defaultRole, or a role outside allowedRoles. The exposure must not
    // claim visitors act with a working service token in those configs —
    // and a present-but-rejected token never falls back to anonRole.
    const result = { token: 'tok', warning: 'API will reject it with 403', knownRejected: true };
    expect(classifyAdminUiExposure(hs256, result, true)).toBe('rejected');
    expect(classifyAdminUiExposure({ ...hs256, anonRole: 'web_anon' }, result, true)).toBe(
      'rejected',
    );
  });

  it('matches what resolveAdminUiToken actually returns for known-rejected mints', async () => {
    const minter: ServiceTokenMinter = {
      signServiceToken: () => Promise.resolve('minted-token'),
    };
    // No ui.role and no defaultRole.
    const noRole = await resolveAdminUiToken(
      { ...(await makeConfig()), auth: { jwt: { secret: 's' } } },
      minter,
      {},
    );
    expect(noRole.knownRejected).toBe(true);
    expect(classifyAdminUiExposure({ jwt: { secret: 's' } }, noRole, true)).toBe('rejected');

    // Minted role outside allowedRoles.
    const auth = {
      jwt: { secret: 's' },
      allowedRoles: ['app_reader'],
      ui: { role: 'app_admin' },
    };
    const badRole = await resolveAdminUiToken({ ...(await makeConfig()), auth }, minter, {});
    expect(badRole.knownRejected).toBe(true);
    expect(classifyAdminUiExposure(auth, badRole, true)).toBe('rejected');

    // A clean mint stays service-token.
    const cleanAuth = { jwt: { secret: 's' }, defaultRole: 'app_reader' };
    const clean = await resolveAdminUiToken({ ...(await makeConfig()), auth: cleanAuth }, minter, {});
    expect(clean.knownRejected).toBeUndefined();
    expect(classifyAdminUiExposure(cleanAuth, clean, true)).toBe('service-token');
  });
});

describe('resolveAdminUiEntry', () => {
  it('resolves the bundled svelte-ui adapter-node server entry', () => {
    const entry = resolveAdminUiEntry();
    expect(entry.endsWith('build/index.js')).toBe(true);
    // @kozou/svelte-ui is a workspace dependency whose build output is
    // present after `pnpm -r build`, so the entry must exist on disk.
    expect(existsSync(entry)).toBe(true);
  });
});

describe('buildAdminUiEnv privilege-aware introspection (#99)', () => {
  it('omits KOZOU_INTROSPECTION_ROLE when respectPrivileges is off', async () => {
    const config = await makeConfig();
    const env = buildAdminUiEnv(config, 'http://localhost:3333', {});
    expect(env.KOZOU_INTROSPECTION_ROLE).toBeUndefined();
  });

  it('passes the resolved role through when respectPrivileges is on', async () => {
    const base = await makeConfig();
    const config: KozouConfig = {
      ...base,
      introspection: { respectPrivileges: true },
      auth: { jwt: { secret: 's' }, ui: { role: 'app_user' } },
    };
    const env = buildAdminUiEnv(config, 'http://localhost:3333', {});
    expect(env.KOZOU_INTROSPECTION_ROLE).toBe('app_user');
  });

  it('is authoritative: a stray parent value is dropped when the feature is off', async () => {
    const config = await makeConfig();
    const env = buildAdminUiEnv(config, 'http://localhost:3333', {
      KOZOU_INTROSPECTION_ROLE: 'sneaky',
    });
    expect(env.KOZOU_INTROSPECTION_ROLE).toBeUndefined();
  });

  it('throws on the API path when a KOZOU_ADAPTER_TOKEN is inherited but no introspection.role is set', async () => {
    const base = await makeConfig();
    const config: KozouConfig = {
      ...base,
      introspection: { respectPrivileges: true },
      auth: { jwt: { secret: 's' }, ui: { role: 'app_user' } },
    };
    // On the in-house API path a ready-made token in the environment wins over
    // minting, so its role — not auth.ui.role — is what the UI uses; the
    // resolver must refuse to guess.
    expect(() =>
      buildAdminUiEnv(
        config,
        'http://localhost:3333',
        { KOZOU_ADAPTER_TOKEN: 'env.jwt' },
        'http://127.0.0.1:3335',
      ),
    ).toThrow();
  });

  it('REST opt-out path does NOT gate on an inherited KOZOU_ADAPTER_TOKEN (it is cleared, never used)', async () => {
    const base = await makeConfig();
    const config: KozouConfig = {
      ...base,
      introspection: { respectPrivileges: true },
      auth: { jwt: { secret: 's' }, ui: { role: 'app_user' } },
    };
    // No apiAdapterUrl -> REST opt-out: the token is cleared and the UI talks to
    // config.adapter.url, so the inherited token must not force introspection.role.
    const env = buildAdminUiEnv(config, 'http://localhost:3333', { KOZOU_ADAPTER_TOKEN: 'env.jwt' });
    expect(env.KOZOU_ADAPTER_TOKEN).toBeUndefined();
    expect(env.KOZOU_INTROSPECTION_ROLE).toBe('app_user');
  });
});

describe('resolveDevPrivilegeRole (#99) — shared by the Admin UI child and in-process MCP', () => {
  it('returns undefined when the feature is off', async () => {
    const config = await makeConfig();
    expect(resolveDevPrivilegeRole(config, { apiActive: true, env: {} })).toBeUndefined();
  });

  it('resolves the role when on, so MCP annotates the same role the UI runs as', async () => {
    const base = await makeConfig();
    const config: KozouConfig = {
      ...base,
      introspection: { respectPrivileges: true },
      auth: { jwt: { secret: 's' }, ui: { role: 'app_user' } },
    };
    expect(resolveDevPrivilegeRole(config, { apiActive: true, env: {} })).toBe('app_user');
  });

  it('only gates on an inherited token when the API path is active', async () => {
    const base = await makeConfig();
    const config: KozouConfig = {
      ...base,
      introspection: { respectPrivileges: true },
      auth: { jwt: { secret: 's' }, ui: { role: 'app_user' } },
    };
    // API path + inherited token, no introspection.role -> must refuse to guess.
    expect(() =>
      resolveDevPrivilegeRole(config, { apiActive: true, env: { KOZOU_ADAPTER_TOKEN: 'jwt' } }),
    ).toThrow();
    // REST opt-out: the token is never used, so it must not gate.
    expect(
      resolveDevPrivilegeRole(config, { apiActive: false, env: { KOZOU_ADAPTER_TOKEN: 'jwt' } }),
    ).toBe('app_user');
  });
});
