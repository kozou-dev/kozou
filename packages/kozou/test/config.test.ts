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

  it('$${VAR} escapes to a literal ${VAR} (not expanded even when VAR is set)', async () => {
    const dir = await makeTempDir();
    const file = await writeYaml(
      dir,
      `database:
  url: postgres://u:p@h:5432/db
adapter:
  url: http://host/$\${TOKEN}
`,
    );
    const config = await loadConfig({
      path: file,
      env: { TOKEN: 'should-not-appear' },
    });
    expect(config.adapter.url).toBe('http://host/${TOKEN}');
  });

  it('$$ becomes a literal $ and coexists with a real ${VAR} expansion', async () => {
    const dir = await makeTempDir();
    const file = await writeYaml(
      dir,
      `database:
  url: postgres://u:p@h:5432/db
adapter:
  url: \${KOZOU_ADAPTER_URL}?cost=$$5
`,
    );
    const config = await loadConfig({
      path: file,
      env: { KOZOU_ADAPTER_URL: 'http://adapter:3000' },
    });
    expect(config.adapter.url).toBe('http://adapter:3000?cost=$5');
  });

  it('a substituted value containing ${...} is taken verbatim (single-level, secret-safe)', async () => {
    const dir = await makeTempDir();
    const file = await writeYaml(
      dir,
      `database:
  url: \${DATABASE_URL}
`,
    );
    // A password that legitimately contains ${...} must survive intact:
    // the env value is substituted once and never re-scanned, so the
    // ${SECRET} fragment is not treated as a placeholder. `SECRET` is
    // intentionally left undefined to prove it is never looked up.
    const config = await loadConfig({
      path: file,
      env: { DATABASE_URL: 'postgres://u:p${SECRET}@h:5432/db' },
    });
    expect(config.database.url).toBe('postgres://u:p${SECRET}@h:5432/db');
  });

  it('auth is absent by default', async () => {
    const config = await loadConfig({
      skipFile: true,
      env: { DATABASE_URL: 'postgres://u:p@h:5432/db' },
    });
    expect(config.auth).toBeUndefined();
  });

  it('parses an auth section from the config file', async () => {
    const dir = await makeTempDir();
    const file = await writeYaml(
      dir,
      `database:
  url: postgres://u:p@h:5432/db
auth:
  jwt:
    secret: shhh
    algorithms: [HS256]
  allowedRoles: [app_reader, app_writer]
  defaultRole: app_reader
`,
    );
    const config = await loadConfig({ path: file, env: {} });
    expect(config.auth?.jwt.secret).toBe('shhh');
    expect(config.auth?.jwt.algorithms).toEqual(['HS256']);
    expect(config.auth?.allowedRoles).toEqual(['app_reader', 'app_writer']);
    expect(config.auth?.defaultRole).toBe('app_reader');
  });

  it('builds auth from KOZOU_JWT_* env when the file declares none', async () => {
    const config = await loadConfig({
      skipFile: true,
      env: {
        DATABASE_URL: 'postgres://u:p@h:5432/db',
        KOZOU_JWT_SECRET: 'env-secret',
        KOZOU_JWT_ALGORITHMS: 'HS256, RS256',
        KOZOU_JWT_ISSUER: 'kozou',
        KOZOU_JWT_ALLOWED_ROLES: 'app_reader, app_writer',
        KOZOU_JWT_DEFAULT_ROLE: 'app_reader',
      },
    });
    expect(config.auth?.jwt.secret).toBe('env-secret');
    expect(config.auth?.jwt.algorithms).toEqual(['HS256', 'RS256']);
    expect(config.auth?.jwt.issuer).toBe('kozou');
    expect(config.auth?.allowedRoles).toEqual(['app_reader', 'app_writer']);
    expect(config.auth?.defaultRole).toBe('app_reader');
  });

  it('uses KOZOU_JWT_PUBLIC_KEY for RS256 env config', async () => {
    const config = await loadConfig({
      skipFile: true,
      env: {
        DATABASE_URL: 'postgres://u:p@h:5432/db',
        KOZOU_JWT_PUBLIC_KEY: '-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----',
      },
    });
    expect(config.auth?.jwt.publicKey).toContain('BEGIN PUBLIC KEY');
    expect(config.auth?.jwt.secret).toBeUndefined();
  });

  it('a file auth section wins over KOZOU_JWT_* env', async () => {
    const dir = await makeTempDir();
    const file = await writeYaml(
      dir,
      `database:
  url: postgres://u:p@h:5432/db
auth:
  jwt:
    secret: from-file
`,
    );
    const config = await loadConfig({ path: file, env: { KOZOU_JWT_SECRET: 'from-env' } });
    expect(config.auth?.jwt.secret).toBe('from-file');
  });

  it('does not build auth when no JWT key env is present', async () => {
    const config = await loadConfig({
      skipFile: true,
      env: { DATABASE_URL: 'postgres://u:p@h:5432/db', KOZOU_JWT_ISSUER: 'kozou' },
    });
    expect(config.auth).toBeUndefined();
  });

  it('takes an env-provided secret verbatim (not re-expanded)', async () => {
    const config = await loadConfig({
      skipFile: true,
      env: { DATABASE_URL: 'postgres://u:p@h:5432/db', KOZOU_JWT_SECRET: 'a${NOT_EXPANDED}b' },
    });
    expect(config.auth?.jwt.secret).toBe('a${NOT_EXPANDED}b');
  });

  it('parses auth.anonRole from the config file', async () => {
    const dir = await makeTempDir();
    const file = await writeYaml(
      dir,
      `database:
  url: postgres://u:p@h:5432/db
auth:
  jwt:
    secret: shhh
  anonRole: web_anon
`,
    );
    const config = await loadConfig({ path: file, env: {} });
    expect(config.auth?.anonRole).toBe('web_anon');
  });

  it('builds auth.anonRole from KOZOU_JWT_ANON_ROLE env', async () => {
    const config = await loadConfig({
      skipFile: true,
      env: {
        DATABASE_URL: 'postgres://u:p@h:5432/db',
        KOZOU_JWT_SECRET: 'env-secret',
        KOZOU_JWT_ANON_ROLE: 'web_anon',
      },
    });
    expect(config.auth?.anonRole).toBe('web_anon');
  });

  it('parses an auth.ui section from the config file', async () => {
    const dir = await makeTempDir();
    const file = await writeYaml(
      dir,
      `database:
  url: postgres://u:p@h:5432/db
auth:
  jwt:
    secret: shhh
  ui:
    role: app_admin
    token: ready-made-token
`,
    );
    const config = await loadConfig({ path: file, env: {} });
    expect(config.auth?.ui?.role).toBe('app_admin');
    expect(config.auth?.ui?.token).toBe('ready-made-token');
  });

  it('builds auth.ui from KOZOU_UI_ROLE / KOZOU_ADAPTER_TOKEN env', async () => {
    const config = await loadConfig({
      skipFile: true,
      env: {
        DATABASE_URL: 'postgres://u:p@h:5432/db',
        KOZOU_JWT_SECRET: 'env-secret',
        KOZOU_UI_ROLE: 'app_admin',
        KOZOU_ADAPTER_TOKEN: 'env-token',
      },
    });
    expect(config.auth?.ui?.role).toBe('app_admin');
    expect(config.auth?.ui?.token).toBe('env-token');
  });

  it('omits auth.ui when no UI role / token env is present', async () => {
    const config = await loadConfig({
      skipFile: true,
      env: { DATABASE_URL: 'postgres://u:p@h:5432/db', KOZOU_JWT_SECRET: 'env-secret' },
    });
    expect(config.auth?.ui).toBeUndefined();
  });
});
