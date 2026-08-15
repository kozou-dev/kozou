import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { loadConfig, type KozouConfig } from '../src/config.js';
import {
  UI_MCP_POSTURE_ENV,
  UI_MCP_POSTURE_LOCAL,
  UI_MCP_POSTURE_OAUTH,
  UI_MCP_POSTURE_OFF,
  UI_MCP_RESOURCE_ENV,
  UI_MCP_ADVERTISED_URL_ENV,
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

// A config whose MCP HTTP endpoint is an OAuth 2.1 protected resource. Loaded
// from a real file rather than hand-built, so the auth block is the shape the
// schema actually produces (defaults included).
async function makeOauthMcpConfig(): Promise<KozouConfig> {
  const dir = await mkdtemp(join(tmpdir(), `kozou-dev-${randomBytes(4).toString('hex')}-`));
  const file = join(dir, 'kozou.config.yaml');
  await writeFile(
    file,
    [
      'database:',
      '  url: postgres://u:p@db:5432/app',
      'server:',
      '  mcp:',
      '    http:',
      '      auth:',
      '        resource: https://mcp.example.com/mcp',
      '        authorizationServers:',
      '          - https://as.example.com',
      '        jwt:',
      '          jwksUri: https://as.example.com/.well-known/jwks.json',
      '',
    ].join('\n'),
    'utf8',
  );
  return loadConfig({ path: file, env: {} });
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
      // ...and how that endpoint authenticates: no auth block -> 'local'.
      KOZOU_UI_MCP_POSTURE: 'local',
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
    // The endpoint is on with no auth block, which is a posture of its own —
    // the page states "no authentication" only for this one.
    expect(env.KOZOU_UI_MCP_POSTURE).toBe('local');
  });

  it('reports the OAuth posture when server.mcp.http.auth is configured', async () => {
    const config = await makeOauthMcpConfig();
    const env = buildAdminUiEnv(config, 'http://localhost:3333', {});
    // Same endpoint, same port, different truth about authentication: without
    // this the page asserts "no authentication" about a protected resource.
    expect(env.KOZOU_UI_MCP_POSTURE).toBe('oauth');
    expect(env.KOZOU_MCP_HTTP_PORT).toBe('3334');
  });

  it('passes the canonical resource URI in the OAuth posture', async () => {
    const config = await makeOauthMcpConfig();
    const env = buildAdminUiEnv(config, 'http://localhost:3333', {});
    // The page would otherwise build the endpoint from the browser's host, which
    // is wrong in the deployment `resource` exists for (a proxy in front of it).
    expect(env.KOZOU_UI_MCP_RESOURCE).toBe('https://mcp.example.com/mcp');
  });

  it('passes no resource, and clears an inherited one, without an auth block', async () => {
    const config = await makeConfig();
    const env = buildAdminUiEnv(config, 'http://localhost:3333', {
      KOZOU_UI_MCP_RESOURCE: 'https://stale.example.com/mcp',
    });
    // A stale value must not address a runtime that declared no canonical URI.
    expect(env.KOZOU_UI_MCP_RESOURCE).toBeUndefined();
  });

  it('clears an inherited resource when the endpoint is off', async () => {
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
    const env = buildAdminUiEnv(custom, 'http://localhost:3333', {
      KOZOU_UI_MCP_RESOURCE: 'https://stale.example.com/mcp',
    });
    expect(env.KOZOU_UI_MCP_RESOURCE).toBeUndefined();
  });

  it('passes the declared reachable address when there is no auth block', async () => {
    const config = await makeConfig();
    const custom: KozouConfig = {
      ...config,
      server: {
        ...config.server,
        mcp: {
          ...config.server.mcp,
          http: {
            ...config.server.mcp.http,
            advertisedUrl: 'http://localhost:4334/mcp',
          },
        },
      },
    };
    const env = buildAdminUiEnv(custom, 'http://localhost:3333', {});
    // The bind port and the reachable address are different facts once an
    // indirection exists; the page must be handed the second one (issue #258).
    expect(env.KOZOU_UI_MCP_ADVERTISED_URL).toBe('http://localhost:4334/mcp');
    expect(env.KOZOU_MCP_HTTP_PORT).toBe('3334');
    expect(env.KOZOU_UI_MCP_POSTURE).toBe('local');
  });

  it('passes no advertised address, and clears an inherited one, when none is declared', async () => {
    const config = await makeConfig();
    const env = buildAdminUiEnv(config, 'http://localhost:3333', {
      KOZOU_UI_MCP_ADVERTISED_URL: 'http://stale.example.com:4334/mcp',
    });
    // Same rule as the resource URI: a value from another stack must not
    // address this one.
    expect(env.KOZOU_UI_MCP_ADVERTISED_URL).toBeUndefined();
  });

  it('passes no advertised address when the endpoint is off, even though one is declared', async () => {
    // The config carries BOTH `enabled: false` and an advertisedUrl. Dropping
    // the `enabled` half of the condition has to fail here — an earlier version
    // of this test replaced the whole `http` object and so left advertisedUrl
    // undefined, which made it a duplicate of the test above and left that
    // branch unconstrained. The schema refuses this combination, so it is
    // reachable only by building the object directly; the runtime still checks,
    // because a page for an endpoint that is off must not be handed an address.
    const config = await makeConfig();
    const custom: KozouConfig = {
      ...config,
      server: {
        ...config.server,
        mcp: {
          ...config.server.mcp,
          http: {
            ...config.server.mcp.http,
            enabled: false,
            advertisedUrl: 'http://localhost:4334/mcp',
          },
        },
      },
    };
    const env = buildAdminUiEnv(custom, 'http://localhost:3333', {
      KOZOU_UI_MCP_ADVERTISED_URL: 'http://stale.example.com:4334/mcp',
    });
    expect(env.KOZOU_UI_MCP_ADVERTISED_URL).toBeUndefined();
    expect(env.KOZOU_UI_MCP_POSTURE).toBe('off');
  });

  it('never hands the page two declared addresses at once', async () => {
    // The schema refuses the combination, so this is reachable only by
    // constructing the config object directly — which is exactly why the
    // runtime branch is exclusive rather than trusting validation upstream.
    // Two addresses would mean the page picks, and the page must not have to.
    const config = await makeOauthMcpConfig();
    const custom: KozouConfig = {
      ...config,
      server: {
        ...config.server,
        mcp: {
          ...config.server.mcp,
          http: {
            ...config.server.mcp.http,
            advertisedUrl: 'http://localhost:4334/mcp',
          },
        },
      },
    };
    const env = buildAdminUiEnv(custom, 'http://localhost:3333', {});
    const declared = [env.KOZOU_UI_MCP_RESOURCE, env.KOZOU_UI_MCP_ADVERTISED_URL].filter(
      (v) => v !== undefined,
    );
    expect(declared).toHaveLength(1);
    // And the one that survives is the one clients obey: an MCP client reads
    // the endpoint's RFC 9728 metadata, which names `resource`.
    expect(env.KOZOU_UI_MCP_RESOURCE).toBe('https://mcp.example.com/mcp');
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
    expect(env.KOZOU_UI_MCP_POSTURE).toBe('off');
    expect(env.KOZOU_MCP_HTTP_PORT).toBeUndefined();
  });

  it('overwrites a stray inherited posture with the one this runtime is in', async () => {
    const config = await makeConfig();
    // A parent environment claiming the endpoint is off must not hide a
    // connection page for an endpoint this runtime is in fact serving — nor,
    // now, describe an authentication posture this runtime is not in.
    const env = buildAdminUiEnv(config, 'http://localhost:3333', {
      KOZOU_UI_MCP_POSTURE: 'off',
    });
    expect(env.KOZOU_UI_MCP_POSTURE).toBe('local');
    expect(env.KOZOU_MCP_HTTP_PORT).toBe('3334');
  });

  it('overwrites a stray inherited posture that overstates authentication', async () => {
    const config = await makeConfig();
    // The dangerous direction too: an inherited 'oauth' must not make a page
    // for an unauthenticated endpoint claim it is protected.
    const env = buildAdminUiEnv(config, 'http://localhost:3333', {
      KOZOU_UI_MCP_POSTURE: 'oauth',
    });
    expect(env.KOZOU_UI_MCP_POSTURE).toBe('local');
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

describe('the Admin UI posture channel is a cross-package contract', () => {
  // buildAdminUiEnv writes UI_MCP_POSTURE_ENV; the Admin UI reads that name in
  // two server loads, in another package, and matches the values written here.
  // Nothing else connects the two — no shared type, and no test crosses the
  // boundary — so a rename on one side alone would leave every unit test,
  // typecheck and lint green while the connection page silently disappeared,
  // came back, or described the wrong authentication posture. These assertions
  // are what turn that into a failing test.
  const READERS = [
    '../../svelte-ui/src/routes/+layout.server.ts',
    '../../svelte-ui/src/routes/connect/+page.server.ts',
  ];

  it('is the exact env name both Admin UI server loads read', () => {
    // Anchored with a negative lookahead, not `toContain`: a substring check
    // passes against a *longer* name (KOZOU_UI_MCP_POSTURE_RENAMED contains
    // KOZOU_UI_MCP_POSTURE), which is exactly the rename this test catches.
    const reference = new RegExp(`process\\.env\\.${UI_MCP_POSTURE_ENV}(?![A-Za-z0-9_])`);
    for (const rel of READERS) {
      const src = readFileSync(new URL(rel, import.meta.url), 'utf8');
      expect(src).toMatch(reference);
    }
  });

  it('is the exact env name the connection page reads the resource URI from', () => {
    // Same contract, and a quieter failure if it breaks: the page would fall
    // back to the request host and hand out an address that cannot connect,
    // with no error anywhere.
    const src = readFileSync(
      new URL('../../svelte-ui/src/routes/connect/+page.server.ts', import.meta.url),
      'utf8',
    );
    expect(src).toMatch(new RegExp(`process\\.env\\.${UI_MCP_RESOURCE_ENV}(?![A-Za-z0-9_])`));
  });

  it('is the exact env name the connection page reads the advertised address from', () => {
    // Breaks the same way and just as quietly: the page would go back to
    // guessing from the request host, and the operator would get config for a
    // port nothing answers on with nothing logged anywhere.
    const src = readFileSync(
      new URL('../../svelte-ui/src/routes/connect/+page.server.ts', import.meta.url),
      'utf8',
    );
    expect(src).toMatch(new RegExp(`process\\.env\\.${UI_MCP_ADVERTISED_URL_ENV}(?![A-Za-z0-9_])`));
  });

  it('are the exact posture values the Admin UI helper matches on', () => {
    const helper = readFileSync(
      new URL('../../svelte-ui/src/lib/connect/mcp-connection.ts', import.meta.url),
      'utf8',
    );
    // `=== '<value>'` rather than the bare value: the comparison is the code
    // that has to agree, and a value merely named in prose would not.
    // A posture this CLI emits but the helper stopped matching resolves there
    // as "unknown", which silently downgrades correct wording to a hedge.
    for (const posture of [UI_MCP_POSTURE_OFF, UI_MCP_POSTURE_LOCAL, UI_MCP_POSTURE_OAUTH]) {
      expect(helper).toContain(`=== '${posture}'`);
    }
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
