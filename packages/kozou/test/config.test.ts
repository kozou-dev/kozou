import { describe, it, expect } from 'vitest';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { loadConfig, KozouConfigError } from '../src/config.js';

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), `kozou-config-${randomBytes(4).toString('hex')}-`));
}

async function writeYaml(dir: string, content: string): Promise<string> {
  const file = join(dir, 'kozou.config.yaml');
  await writeFile(file, content, 'utf8');
  return file;
}

describe('loadConfig', () => {
  it('no file + DATABASE_URL env -> defaults with that database url', async () => {
    const config = await loadConfig({
      skipFile: true,
      env: { DATABASE_URL: 'postgres://u:p@localhost:5432/x' },
    });
    expect(config.database.url).toBe('postgres://u:p@localhost:5432/x');
    expect(config.database.schemas).toEqual(['public']);
    expect(config.server.ui.port).toBe(3333);
    expect(config.server.ui.host).toBe('0.0.0.0');
    expect(config.server.mcp.http.port).toBe(3334);
    expect(config.server.mcp.stdio).toBe(false);
    expect(config.adapter.type).toBe('postgrest');
    expect(config.adapter.url).toBe('http://postgrest:3000');
    expect(config.uiHints.path).toBeNull();
    expect(config.cache.ttlMs).toBe(60_000);
  });

  it('no file + no DATABASE_URL -> KozouConfigError on database.url', async () => {
    await expect(loadConfig({ skipFile: true, env: {} })).rejects.toBeInstanceOf(
      KozouConfigError,
    );
  });

  it('explicit file overrides defaults', async () => {
    const dir = await makeTempDir();
    const file = await writeYaml(
      dir,
      `database:
  url: postgres://u:p@host:5432/db
  schemas: [public, audit]
server:
  ui:
    port: 4000
  mcp:
    stdio: true
adapter:
  url: http://api:3000
cache:
  ttlMs: 1000
`,
    );
    const config = await loadConfig({ path: file, env: {} });
    expect(config.database.url).toBe('postgres://u:p@host:5432/db');
    expect(config.database.schemas).toEqual(['public', 'audit']);
    expect(config.server.ui.port).toBe(4000);
    expect(config.server.ui.host).toBe('0.0.0.0');
    expect(config.server.mcp.stdio).toBe(true);
    expect(config.adapter.url).toBe('http://api:3000');
    expect(config.cache.ttlMs).toBe(1000);
  });

  it('expands ${VAR} placeholders from env', async () => {
    const dir = await makeTempDir();
    const file = await writeYaml(
      dir,
      `database:
  url: \${DATABASE_URL}
adapter:
  url: \${KOZOU_ADAPTER_URL}
`,
    );
    const config = await loadConfig({
      path: file,
      env: {
        DATABASE_URL: 'postgres://expanded:5432/db',
        KOZOU_ADAPTER_URL: 'http://expanded-adapter:3000',
      },
    });
    expect(config.database.url).toBe('postgres://expanded:5432/db');
    expect(config.adapter.url).toBe('http://expanded-adapter:3000');
  });

  it('expands ${VAR:-default} placeholders when VAR is unset', async () => {
    const dir = await makeTempDir();
    const file = await writeYaml(
      dir,
      `database:
  url: \${MISSING_VAR:-postgres://fallback:5432/db}
adapter:
  url: \${KOZOU_ADAPTER_URL:-http://default-adapter:3000}
`,
    );
    const config = await loadConfig({ path: file, env: {} });
    expect(config.database.url).toBe('postgres://fallback:5432/db');
    expect(config.adapter.url).toBe('http://default-adapter:3000');
  });

  it('${VAR:-default} prefers env when set', async () => {
    const dir = await makeTempDir();
    const file = await writeYaml(
      dir,
      `database:
  url: \${DATABASE_URL:-postgres://fallback:5432/db}
`,
    );
    const config = await loadConfig({
      path: file,
      env: { DATABASE_URL: 'postgres://chosen:5432/db' },
    });
    expect(config.database.url).toBe('postgres://chosen:5432/db');
  });

  it('invalid YAML -> KozouConfigError', async () => {
    const dir = await makeTempDir();
    const file = await writeYaml(dir, 'database:\n  url: [unclosed\n');
    await expect(
      loadConfig({ path: file, env: { DATABASE_URL: 'x' } }),
    ).rejects.toBeInstanceOf(KozouConfigError);
  });

  it('schema violation surfaces zod issues', async () => {
    const dir = await makeTempDir();
    const file = await writeYaml(
      dir,
      `database:
  url: postgres://u:p@host:5432/db
server:
  ui:
    port: "not-a-number"
`,
    );
    await expect(loadConfig({ path: file, env: {} })).rejects.toBeInstanceOf(
      KozouConfigError,
    );
    try {
      await loadConfig({ path: file, env: {} });
    } catch (err) {
      const e = err as KozouConfigError;
      expect(e.issues.length).toBeGreaterThan(0);
      expect(e.issues.some((i) => i.path.startsWith('server.ui.port'))).toBe(true);
    }
  });

  it('non-existent file path + DATABASE_URL -> defaults', async () => {
    const config = await loadConfig({
      path: '/nonexistent/kozou.config.yaml',
      env: { DATABASE_URL: 'postgres://u:p@x:5432/y' },
    });
    expect(config.database.url).toBe('postgres://u:p@x:5432/y');
  });

  it('database.url from file beats DATABASE_URL env', async () => {
    const dir = await makeTempDir();
    const file = await writeYaml(
      dir,
      `database:
  url: postgres://from-file:5432/db
`,
    );
    const config = await loadConfig({
      path: file,
      env: { DATABASE_URL: 'postgres://from-env:5432/db' },
    });
    expect(config.database.url).toBe('postgres://from-file:5432/db');
  });
});
