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
