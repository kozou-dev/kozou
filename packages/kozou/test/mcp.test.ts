import { describe, expect, it, vi, beforeEach } from 'vitest';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

// Mock the @kozou/mcp surface so the command can be driven without a real
// server / database: SchemaCache is constructed but never queried, and the
// transports are spies we assert the bind options on.
vi.mock('@kozou/mcp', () => ({
  SchemaCache: class {
    constructor(_opts?: unknown) {}
    invalidate(): void {}
  },
  startHttpServer: vi.fn(async () => ({ port: 0, host: '', close: async () => {} })),
  startStdioServer: vi.fn(async () => {}),
}));

import { startHttpServer } from '@kozou/mcp';
import { loadConfig, type KozouConfig } from '../src/config.js';
import { mcpCommand, resolveMcpAnnotationRole } from '../src/commands/mcp.js';

async function makeConfig(): Promise<KozouConfig> {
  return loadConfig({ skipFile: true, env: { DATABASE_URL: 'postgres://u:p@db:5432/app' } });
}

async function writeConfig(body: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `kozou-mcp-${randomBytes(4).toString('hex')}-`));
  const file = join(dir, 'kozou.config.yaml');
  await writeFile(file, body, 'utf8');
  return file;
}

function lastHttpOpts(): { port?: number; host?: string } {
  const calls = (startHttpServer as unknown as { mock: { calls: unknown[][] } }).mock.calls;
  return calls[calls.length - 1]![1] as { port?: number; host?: string };
}

describe('resolveMcpAnnotationRole (#99) — the role describe tools annotate', () => {
  it('returns undefined when respectPrivileges is off (schema-wide)', async () => {
    const config = await makeConfig();
    expect(resolveMcpAnnotationRole(config, undefined, {})).toBeUndefined();
    // Even with execution active, off means off.
    expect(resolveMcpAnnotationRole(config, 'mcp_exec', {})).toBeUndefined();
  });

  it('describe-only: resolves the configured role', async () => {
    const base = await makeConfig();
    const config: KozouConfig = {
      ...base,
      introspection: { respectPrivileges: true, role: 'reporter' },
    };
    expect(resolveMcpAnnotationRole(config, undefined, {})).toBe('reporter');
  });

  it('describe-only: falls back to auth.ui.role / defaultRole', async () => {
    const base = await makeConfig();
    const config: KozouConfig = {
      ...base,
      introspection: { respectPrivileges: true },
      auth: { jwt: { secret: 's' }, ui: { role: 'app_user' } },
    };
    expect(resolveMcpAnnotationRole(config, undefined, {})).toBe('app_user');
  });

  it('describe-only: refuses to guess a ready-made token’s role', async () => {
    const base = await makeConfig();
    const config: KozouConfig = {
      ...base,
      introspection: { respectPrivileges: true },
      auth: { jwt: { secret: 's' }, ui: { role: 'app_user', token: 'ready.made.jwt' } },
    };
    expect(() => resolveMcpAnnotationRole(config, undefined, {})).toThrow();
  });

  it('execution on: annotates the execution role (so it matches what the agent does)', async () => {
    const base = await makeConfig();
    const config: KozouConfig = {
      ...base,
      introspection: { respectPrivileges: true },
    };
    expect(resolveMcpAnnotationRole(config, 'mcp_exec', {})).toBe('mcp_exec');
  });

  it('execution on: a conflicting introspection.role throws (no silent says-A-does-B)', async () => {
    const base = await makeConfig();
    const config: KozouConfig = {
      ...base,
      introspection: { respectPrivileges: true, role: 'reporter' },
    };
    expect(() => resolveMcpAnnotationRole(config, 'mcp_exec', {})).toThrow(/differs from/);
  });

  it('execution on: a matching introspection.role is accepted', async () => {
    const base = await makeConfig();
    const config: KozouConfig = {
      ...base,
      introspection: { respectPrivileges: true, role: 'mcp_exec' },
    };
    expect(resolveMcpAnnotationRole(config, 'mcp_exec', {})).toBe('mcp_exec');
  });
});

describe('mcpCommand --http honours server.mcp.http from config (#159)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const CONFIG = `database:
  url: postgres://u:p@db:5432/app
server:
  mcp:
    http:
      port: 4321
      host: 0.0.0.0
`;

  it('binds the configured port/host when no CLI flag is given', async () => {
    const file = await writeConfig(CONFIG);
    await mcpCommand({ http: true, config: file });
    expect(startHttpServer).toHaveBeenCalledTimes(1);
    expect(lastHttpOpts().port).toBe(4321);
    expect(lastHttpOpts().host).toBe('0.0.0.0');
  });

  it('a CLI --port / --host overrides the config', async () => {
    const file = await writeConfig(CONFIG);
    await mcpCommand({ http: true, port: 9999, host: '127.0.0.1', config: file });
    expect(lastHttpOpts().port).toBe(9999);
    expect(lastHttpOpts().host).toBe('127.0.0.1');
  });
});

describe('resolveMcpAnnotationRole — OAuth mode (per-token acting role)', () => {
  // With server.mcp.http.auth the acting role comes from each verified
  // token, so a single annotated role is only truthful when exactly one
  // role is assumable.
  async function authConfig(overrides: Partial<KozouConfig>): Promise<KozouConfig> {
    const base = await makeConfig();
    return {
      ...base,
      server: {
        ...base.server,
        mcp: {
          ...base.server.mcp,
          http: {
            ...base.server.mcp.http,
            auth: {
              resource: 'https://mcp.example.com/mcp',
              authorizationServers: ['https://as.example.com'],
              scopes: { describe: 'mcp:describe', execute: 'mcp:execute', admin: 'mcp:admin' },
              adminRefresh: false,
            },
          },
        },
      },
      ...overrides,
    };
  }

  it('a single allowed role is annotated', async () => {
    const config = await authConfig({
      introspection: { respectPrivileges: true },
      auth: { jwt: { secret: 's' }, allowedRoles: ['app_viewer'] },
    });
    expect(resolveMcpAnnotationRole(config, undefined, {})).toBe('app_viewer');
  });

  it('the MCP block’s own allowedRoles wins over the top-level list', async () => {
    const config = await authConfig({
      introspection: { respectPrivileges: true },
      auth: { jwt: { secret: 's' }, allowedRoles: ['app_admin', 'app_viewer'] },
    });
    config.server.mcp.http.auth!.allowedRoles = ['app_viewer'];
    expect(resolveMcpAnnotationRole(config, undefined, {})).toBe('app_viewer');
  });

  it('multiple (or absent) allowed roles are refused — per-token annotation is not faked', async () => {
    const multi = await authConfig({
      introspection: { respectPrivileges: true },
      auth: { jwt: { secret: 's' }, allowedRoles: ['app_viewer', 'app_admin'] },
    });
    expect(() => resolveMcpAnnotationRole(multi, undefined, {})).toThrow(/exactly one role/);

    const none = await authConfig({ introspection: { respectPrivileges: true } });
    expect(() => resolveMcpAnnotationRole(none, undefined, {})).toThrow(/exactly one role/);
  });

  it('a conflicting introspection.role throws; a matching one is accepted', async () => {
    const conflicting = await authConfig({
      introspection: { respectPrivileges: true, role: 'reporter' },
      auth: { jwt: { secret: 's' }, allowedRoles: ['app_viewer'] },
    });
    expect(() => resolveMcpAnnotationRole(conflicting, undefined, {})).toThrow(/differs from/);

    const matching = await authConfig({
      introspection: { respectPrivileges: true, role: 'app_viewer' },
      auth: { jwt: { secret: 's' }, allowedRoles: ['app_viewer'] },
    });
    expect(resolveMcpAnnotationRole(matching, undefined, {})).toBe('app_viewer');
  });

  it('respectPrivileges off stays off in OAuth mode', async () => {
    const config = await authConfig({
      auth: { jwt: { secret: 's' }, allowedRoles: ['app_viewer'] },
    });
    expect(resolveMcpAnnotationRole(config, undefined, {})).toBeUndefined();
  });
});

describe('mcpCommand --http passes the OAuth auth options through', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const AUTH_CONFIG = `database:
  url: postgres://u:p@db:5432/app
server:
  mcp:
    http:
      auth:
        resource: https://mcp.example.com/mcp
        authorizationServers:
          - https://as.example.com
        jwt:
          jwksUri: https://as.example.com/jwks
`;

  it('startHttpServer receives the resolved auth block', async () => {
    const file = await writeConfig(AUTH_CONFIG);
    await mcpCommand({ http: true, config: file });
    const opts = lastHttpOpts() as { auth?: { resource: string; jwt: { jwksUri?: string } } };
    expect(opts.auth?.resource).toBe('https://mcp.example.com/mcp');
    expect(opts.auth?.jwt.jwksUri).toBe('https://as.example.com/jwks');
  });

  it('no auth block -> no auth option (unchanged no-auth mode)', async () => {
    const file = await writeConfig('database:\n  url: postgres://u:p@db:5432/app\n');
    await mcpCommand({ http: true, config: file });
    expect((lastHttpOpts() as { auth?: unknown }).auth).toBeUndefined();
  });

  it('stdio with an HTTP-auth config + execution but no role fails early (clear error, not a late crash)', async () => {
    // The auth block relaxes execution.role only for --http (per-token
    // identity); a stdio run of the same config must not reach startStdioServer
    // with no identity — it errors up front instead.
    const file = await writeConfig(`database:
  url: postgres://u:p@db:5432/app
server:
  mcp:
    http:
      auth:
        resource: https://mcp.example.com/mcp
        authorizationServers:
          - https://as.example.com
        jwt:
          jwksUri: https://as.example.com/jwks
        allowedRoles: [app_agent]
    execution:
      enabled: true
`);
    await expect(mcpCommand({ stdio: true, config: file })).rejects.toThrow(/execution\.role is required/);
  });
});
