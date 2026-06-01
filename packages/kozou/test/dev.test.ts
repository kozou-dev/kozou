import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { loadConfig, type KozouConfig } from '../src/config.js';
import {
  buildAdminUiEnv,
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
      HOST: '0.0.0.0',
      ORIGIN: 'http://localhost:3333',
      NODE_ENV: 'production',
    });
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

  it('omits KOZOU_ADAPTER_KIND and uses the config url for the default adapter', async () => {
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

  it('does not touch KOZOU_ADAPTER_TOKEN on the default (non-api) path', async () => {
    const config = await makeConfig();
    const env = buildAdminUiEnv(config, 'http://localhost:3333', { KOZOU_ADAPTER_TOKEN: 'x' });
    expect(env.KOZOU_ADAPTER_TOKEN).toBe('x');
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

  it('returns a warning and no token for RS256 with no supplied token', async () => {
    const { minter, calls } = spyMinter();
    const config = await configWithAuth({ jwt: { publicKey: '-----BEGIN PUBLIC KEY-----' } });
    const result = await resolveAdminUiToken(config, minter, {});
    expect(result.token).toBeUndefined();
    expect(result.warning).toMatch(/RS256/);
    expect(calls).toHaveLength(0);
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
