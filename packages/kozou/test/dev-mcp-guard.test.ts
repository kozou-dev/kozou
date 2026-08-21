// `kozou dev` hands the MCP HTTP server the rebinding-guard options.
//
// Its own test file because it mocks @kozou/mcp wholesale, which the rest of
// dev.test.ts must not be subject to. Behavioural rather than a source-text
// assertion: the failure being guarded is a call site that stops passing a key
// — and a disabled, inverted or commented-out pass-through leaves the text
// intact, so only inspecting the options object catches it. The symptom is
// silent and total (a tunnelled deployment refuses every request while the
// guard's startup line still looks correct), which is why it is pinned here as
// well as for `kozou mcp --http` in mcp.test.ts.

import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@kozou/mcp', () => ({
  SchemaCache: class {
    constructor(_opts?: unknown) {}
    invalidate(): void {}
  },
  startHttpServer: vi.fn(async () => ({ port: 0, host: '', close: async () => {} })),
  startStdioServer: vi.fn(async () => {}),
  unusableAllowedHostReason: (entry: string): string | undefined =>
    entry.includes('/') ? 'it is a URL or carries a path' : undefined,
}));

import { startHttpServer } from '@kozou/mcp';
import { startDevMcp } from '../src/commands/dev.js';
import { loadConfig } from '../src/config.js';

async function configFrom(env: Record<string, string>): Promise<Awaited<ReturnType<typeof loadConfig>>> {
  return loadConfig({
    skipFile: true,
    env: { DATABASE_URL: 'postgres://u:p@localhost:5432/x', ...env },
  });
}

async function configFromYaml(body: string): Promise<Awaited<ReturnType<typeof loadConfig>>> {
  const dir = await mkdtemp(join(tmpdir(), `kozou-devguard-${randomBytes(4).toString('hex')}-`));
  const file = join(dir, 'kozou.config.yaml');
  await writeFile(file, body, 'utf8');
  return loadConfig({ path: file, env: {} });
}

function lastOpts(): { advertisedUrl?: string; allowedHosts?: string[] } {
  const calls = (startHttpServer as unknown as { mock: { calls: unknown[][] } }).mock.calls;
  return calls[calls.length - 1]![1] as { advertisedUrl?: string; allowedHosts?: string[] };
}

describe('startDevMcp — rebinding-guard options', () => {
  beforeEach(() => {
    (startHttpServer as unknown as { mock: { calls: unknown[][] } }).mock.calls.length = 0;
  });

  it('passes the declared address and the extra Host names', async () => {
    const config = await configFromYaml(`database:
  url: postgres://u:p@localhost:5432/x
server:
  mcp:
    http:
      advertisedUrl: https://mcp.example.com/mcp
      allowedHosts:
        - tunnel.example.com
`);
    await startDevMcp(config, false);
    expect(lastOpts().advertisedUrl).toBe('https://mcp.example.com/mcp');
    expect(lastOpts().allowedHosts).toEqual(['tunnel.example.com']);
  });

  it('passes them from the environment too (the container path has no config file)', async () => {
    const config = await configFrom({
      KOZOU_MCP_HTTP_ADVERTISED_URL: 'https://mcp.example.com/mcp',
      KOZOU_MCP_HTTP_ALLOWED_HOSTS: 'tunnel.example.com,mcp.internal:3334',
    });
    await startDevMcp(config, false);
    expect(lastOpts().advertisedUrl).toBe('https://mcp.example.com/mcp');
    expect(lastOpts().allowedHosts).toEqual(['tunnel.example.com', 'mcp.internal:3334']);
  });

  it('passes neither key when neither is set', async () => {
    const config = await configFrom({});
    await startDevMcp(config, false);
    expect(lastOpts().advertisedUrl).toBeUndefined();
    expect(lastOpts().allowedHosts).toBeUndefined();
  });
});
