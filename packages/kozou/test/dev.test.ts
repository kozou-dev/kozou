import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { loadConfig, type KozouConfig } from '../src/config.js';
import {
  buildAdminUiEnv,
  resolveOrigin,
  resolveAdminUiEntry,
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
