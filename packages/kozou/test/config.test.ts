import { describe, it, expect } from 'vitest';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import {
  loadConfig,
  resolvePrivilegeRole,
  hasReadyMadeToken,
  resolveMcpAuthOptions,
  configSchema,
  KozouConfigError,
} from '../src/config.js';
import type { KozouConfig } from '../src/config.js';

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), `kozou-config-${randomBytes(4).toString('hex')}-`));
}

async function writeYaml(dir: string, content: string): Promise<string> {
  const file = join(dir, 'kozou.config.yaml');
  await writeFile(file, content, 'utf8');
  return file;
}

/**
 * Load a config expected to fail validation, and hand back the error itself.
 * The thrown message is a count ("Invalid kozou config: N issue(s)"), so which
 * field was refused lives in `issues` — asserting there is what distinguishes
 * "this field was rejected" from "something, somewhere, was".
 */
async function captureConfigError(
  options: Parameters<typeof loadConfig>[0],
): Promise<KozouConfigError> {
  let thrown: unknown;
  try {
    await loadConfig(options);
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(KozouConfigError);
  return thrown as KozouConfigError;
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
    // No-auth surfaces bind loopback by default (a container opts into 0.0.0.0).
    expect(config.server.ui.host).toBe('127.0.0.1');
    expect(config.server.mcp.http.enabled).toBe(true);
    expect(config.server.mcp.http.port).toBe(3334);
    expect(config.server.mcp.http.host).toBe('127.0.0.1');
    expect(config.server.mcp.stdio).toBe(false);
    // The MCP `call` execution tool is opt-in; default off (describe-only).
    expect(config.server.mcp.execution.enabled).toBe(false);
    expect(config.adapter.type).toBe('api');
    expect(config.adapter.url).toBe('http://postgrest:3000');
    expect(config.uiHints.path).toBeNull();
    expect(config.cache.ttlMs).toBe(60_000);
    // RPC exposure (issue #103) defaults to nothing extra opted in.
    expect(config.api.rpc.allowDefiner).toEqual([]);
    expect(config.api.rpc.allowPublicExecute).toEqual([]);
  });

  it('parses api.rpc allowlists (schema-qualified function names)', async () => {
    const dir = await makeTempDir();
    const file = await writeYaml(
      dir,
      `database:
  url: postgres://u:p@host:5432/db
api:
  rpc:
    allowDefiner:
      - public.approve_order
      - billing.settle_invoice
    allowPublicExecute:
      - public.search
`,
    );
    const config = await loadConfig({ path: file, env: {} });
    expect(config.api.rpc.allowDefiner).toEqual(['public.approve_order', 'billing.settle_invoice']);
    expect(config.api.rpc.allowPublicExecute).toEqual(['public.search']);
  });

  it('parses server.mcp.execution (opt-in call tool)', async () => {
    const dir = await makeTempDir();
    const file = await writeYaml(
      dir,
      `database:
  url: postgres://u:p@host:5432/db
server:
  mcp:
    execution:
      enabled: true
      role: kozou_mcp_agent
      claims: { tenant_id: acme }
      allow:
        - public.approve_order
`,
    );
    const config = await loadConfig({ path: file, env: {} });
    expect(config.server.mcp.execution.enabled).toBe(true);
    expect(config.server.mcp.execution.role).toBe('kozou_mcp_agent');
    expect(config.server.mcp.execution.claims).toEqual({ tenant_id: 'acme' });
    expect(config.server.mcp.execution.allow).toEqual(['public.approve_order']);
  });

  it('parses server.mcp.http.enabled false (endpoint opted out)', async () => {
    const dir = await makeTempDir();
    const file = await writeYaml(
      dir,
      `database:
  url: postgres://u:p@host:5432/db
server:
  mcp:
    http:
      enabled: false
`,
    );
    const config = await loadConfig({ path: file, env: {} });
    expect(config.server.mcp.http.enabled).toBe(false);
    // stdio is a separate transport and stays at its own default.
    expect(config.server.mcp.stdio).toBe(false);
  });

  it('rejects server.mcp.http.auth under a disabled endpoint (dead config)', async () => {
    const dir = await makeTempDir();
    const file = await writeYaml(
      dir,
      `database:
  url: postgres://u:p@host:5432/db
server:
  mcp:
    http:
      enabled: false
      auth:
        resource: https://example.test/mcp
        authorizationServers:
          - https://idp.example.test
        jwt:
          jwksUri: https://idp.example.test/jwks
`,
    );
    await expect(loadConfig({ path: file, env: {} })).rejects.toBeInstanceOf(KozouConfigError);
  });

  it('rejects server.mcp.execution.enabled without a role', async () => {
    const dir = await makeTempDir();
    const file = await writeYaml(
      dir,
      `database:
  url: postgres://u:p@host:5432/db
server:
  mcp:
    execution:
      enabled: true
`,
    );
    await expect(loadConfig({ path: file, env: {} })).rejects.toBeInstanceOf(KozouConfigError);
  });

  it('accepts the postgrest adapter type as an opt-out', async () => {
    const dir = await makeTempDir();
    const file = await writeYaml(
      dir,
      `database:
  url: postgres://u:p@host:5432/db
adapter:
  type: postgrest
  url: http://postgrest:3000
`,
    );
    const config = await loadConfig({ path: file, env: {} });
    expect(config.adapter.type).toBe('postgrest');
    expect(config.adapter.url).toBe('http://postgrest:3000');
  });

  it('rejects an unknown adapter type', async () => {
    const dir = await makeTempDir();
    const file = await writeYaml(
      dir,
      `database:
  url: postgres://u:p@host:5432/db
adapter:
  type: bogus
`,
    );
    await expect(loadConfig({ path: file, env: {} })).rejects.toBeInstanceOf(KozouConfigError);
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
    // host not set in the file -> the loopback default.
    expect(config.server.ui.host).toBe('127.0.0.1');
    expect(config.server.mcp.stdio).toBe(true);
    expect(config.adapter.url).toBe('http://api:3000');
    expect(config.cache.ttlMs).toBe(1000);
  });

  it('KOZOU_UI_HOST / KOZOU_MCP_HTTP_HOST override the bind host (even with no file)', async () => {
    const config = await loadConfig({
      skipFile: true,
      env: {
        DATABASE_URL: 'postgres://u:p@localhost:5432/x',
        KOZOU_UI_HOST: '0.0.0.0',
        KOZOU_MCP_HTTP_HOST: '0.0.0.0',
      },
    });
    expect(config.server.ui.host).toBe('0.0.0.0');
    expect(config.server.mcp.http.host).toBe('0.0.0.0');
  });

  it('KOZOU_MCP_HTTP_ENABLED turns the endpoint off with no file present', async () => {
    // The scaffolded compose stack mounts no config file, so this env route is
    // the only way to opt out in the deployment that actually publishes the
    // endpoint. `${VAR}` expansion cannot serve here either: it would yield the
    // string "false", which the boolean field rightly refuses.
    const config = await loadConfig({
      skipFile: true,
      env: {
        DATABASE_URL: 'postgres://u:p@localhost:5432/x',
        KOZOU_MCP_HTTP_ENABLED: 'false',
      },
    });
    expect(config.server.mcp.http.enabled).toBe(false);
  });

  it('KOZOU_MCP_HTTP_ENABLED can also re-enable an endpoint a file opted out of', async () => {
    const dir = await makeTempDir();
    const file = await writeYaml(
      dir,
      `database:
  url: postgres://u:p@host:5432/db
server:
  mcp:
    http:
      enabled: false
`,
    );
    const config = await loadConfig({ path: file, env: { KOZOU_MCP_HTTP_ENABLED: 'true' } });
    expect(config.server.mcp.http.enabled).toBe(true);
  });

  it('KOZOU_MCP_HTTP_ADVERTISED_URL declares where the endpoint is reached', async () => {
    // The compose stack publishes the endpoint on a host port the operator may
    // have had to remap, and mounts no config file — so the environment is
    // where the reachable address can be stated at all (issue #258).
    const config = await loadConfig({
      skipFile: true,
      env: {
        DATABASE_URL: 'postgres://u:p@localhost:5432/x',
        KOZOU_MCP_HTTP_ADVERTISED_URL: 'http://localhost:4334/mcp',
      },
    });
    expect(config.server.mcp.http.advertisedUrl).toBe('http://localhost:4334/mcp');
    // The bind port is untouched: what the runtime listens on and what clients
    // reach are different facts, which is the whole reason this field exists.
    expect(config.server.mcp.http.port).toBe(3334);
  });

  it('an empty or whitespace-only KOZOU_MCP_HTTP_ADVERTISED_URL reads as unset', async () => {
    // Both shipped compose stacks forward this as `${VAR:-}`, so EVERY
    // scaffolded run passes an empty string. Treating it as a value would fail
    // `min(1)` and take every one of those stacks down at startup. Whitespace
    // gets the same treatment as the boolean env right beside it, so a stray
    // space after the `=` in a .env means what the operator meant.
    for (const raw of ['', '   ']) {
      const config = await loadConfig({
        skipFile: true,
        env: {
          DATABASE_URL: 'postgres://u:p@localhost:5432/x',
          KOZOU_MCP_HTTP_ADVERTISED_URL: raw,
        },
      });
      expect(config.server.mcp.http.advertisedUrl).toBeUndefined();
    }
  });

  it('names KOZOU_MCP_HTTP_ADVERTISED_URL as the source when it supplied a bad value', async () => {
    // Without this the error points at a config file that does not contain the
    // offending value — the failure `envSources` exists to prevent.
    const dir = await makeTempDir();
    const file = await writeYaml(
      dir,
      `database:
  url: postgres://u:p@host:5432/db
`,
    );
    const thrown = await captureConfigError({
      path: file,
      env: { KOZOU_MCP_HTTP_ADVERTISED_URL: 'not-a-url' },
    });
    expect(thrown.envSources).toContain('KOZOU_MCP_HTTP_ADVERTISED_URL');
  });

  it('refuses an advertised URL that does not address the served path', async () => {
    // #258 is "the page hands out config that cannot connect". The transport
    // matches its path exactly, so each of these reproduces that failure
    // through the field added to prevent it.
    for (const bad of [
      'http://localhost:4334',
      'http://localhost:4334/',
      'http://localhost:4334/mcp/',
      'http://localhost:4334/admin',
    ]) {
      const thrown = await captureConfigError({
        skipFile: true,
        env: {
          DATABASE_URL: 'postgres://u:p@localhost:5432/x',
          KOZOU_MCP_HTTP_ADVERTISED_URL: bad,
        },
      });
      expect(thrown.issues.map((i) => i.path)).toContain('server.mcp.http.advertisedUrl');
    }
  });

  it('refuses an advertised URL carrying a query or fragment, as auth.resource does', async () => {
    // The same two refusals resolveMcpHttpAuth applies to `resource`: a
    // fragment never leaves the client and the transport ignores the query, so
    // either one means the operator believes something is sent that is not.
    for (const bad of ['http://localhost:4334/mcp?t=1', 'http://localhost:4334/mcp#f']) {
      const thrown = await captureConfigError({
        skipFile: true,
        env: {
          DATABASE_URL: 'postgres://u:p@localhost:5432/x',
          KOZOU_MCP_HTTP_ADVERTISED_URL: bad,
        },
      });
      expect(thrown.issues.map((i) => i.path)).toContain('server.mcp.http.advertisedUrl');
    }
  });

  it('validates the advertised path against the one @kozou/mcp actually serves', () => {
    // config.ts holds '/mcp' as a literal because @kozou/mcp keeps its own copy
    // private. That is a coupling, so assert the two agree rather than trusting
    // the comment that says they do: if the transport's default path ever moves,
    // this fails instead of the validator silently refusing every correct URL.
    const served = readFileSync(
      new URL('../../mcp/src/startHttpServer.ts', import.meta.url),
      'utf8',
    );
    const match = served.match(/const DEFAULT_MCP_PATH = '([^']+)'/);
    expect(match?.[1]).toBe('/mcp');
  });

  it('refuses an advertised URL that is not an absolute http(s) URL', async () => {
    // No safe fallback: the value exists to replace a guess, so accepting a
    // malformed one would put the guess back while claiming it was declared.
    for (const bad of ['localhost:4334/mcp', '/mcp', 'ftp://host/mcp']) {
      const thrown = await captureConfigError({
        skipFile: true,
        env: {
          DATABASE_URL: 'postgres://u:p@localhost:5432/x',
          KOZOU_MCP_HTTP_ADVERTISED_URL: bad,
        },
      });
      expect(thrown.issues.map((i) => i.path)).toContain('server.mcp.http.advertisedUrl');
    }
  });

  it('refuses an advertised URL on a disabled endpoint', async () => {
    const thrown = await captureConfigError({
      skipFile: true,
      env: {
        DATABASE_URL: 'postgres://u:p@localhost:5432/x',
        KOZOU_MCP_HTTP_ENABLED: 'false',
        KOZOU_MCP_HTTP_ADVERTISED_URL: 'http://localhost:4334/mcp',
      },
    });
    expect(thrown.issues.map((i) => i.path)).toContain('server.mcp.http.advertisedUrl');
  });

  it('refuses an advertised URL alongside an auth block', async () => {
    // Two declared addresses, one of which the endpoint's own metadata names.
    // Picking a winner silently would let the page advertise an address the
    // endpoint does not claim.
    const dir = await makeTempDir();
    const file = await writeYaml(
      dir,
      `database:
  url: postgres://u:p@host:5432/db
server:
  mcp:
    http:
      advertisedUrl: http://localhost:4334/mcp
      auth:
        resource: https://mcp.example.com/mcp
        authorizationServers:
          - https://as.example.com
        scopes:
          describe: mcp:describe
          execute: mcp:execute
        jwt:
          jwksUri: https://as.example.com/jwks
`,
    );
    const thrown = await captureConfigError({ path: file, env: {} });
    expect(thrown.issues.map((i) => i.path)).toContain('server.mcp.http.advertisedUrl');
  });

  it('applies the MCP host and enabled overrides together', async () => {
    const config = await loadConfig({
      skipFile: true,
      env: {
        DATABASE_URL: 'postgres://u:p@localhost:5432/x',
        KOZOU_MCP_HTTP_HOST: '0.0.0.0',
        KOZOU_MCP_HTTP_ENABLED: 'false',
      },
    });
    expect(config.server.mcp.http.host).toBe('0.0.0.0');
    expect(config.server.mcp.http.enabled).toBe(false);
  });

  it('an empty KOZOU_MCP_HTTP_ENABLED leaves the config value in place', async () => {
    const config = await loadConfig({
      skipFile: true,
      env: {
        DATABASE_URL: 'postgres://u:p@localhost:5432/x',
        KOZOU_MCP_HTTP_ENABLED: '',
      },
    });
    expect(config.server.mcp.http.enabled).toBe(true);
  });

  it('rejects a KOZOU_MCP_HTTP_ENABLED value it cannot read', async () => {
    // Reading `0` / `off` / `no` as "on" would keep an unauthenticated listener
    // up while the operator believes they turned it off — the silent posture
    // change this control exists to prevent.
    for (const raw of ['0', '1', 'off', 'no', 'yes', 'disabled']) {
      await expect(
        loadConfig({
          skipFile: true,
          env: {
            DATABASE_URL: 'postgres://u:p@localhost:5432/x',
            KOZOU_MCP_HTTP_ENABLED: raw,
          },
        }),
      ).rejects.toBeInstanceOf(KozouConfigError);
    }
  });

  it('records the env vars that actually fed a config that failed validation', async () => {
    // Validation runs on file + environment merged, so an issue path can point
    // at something no file contains. The sources travel with the error.
    const dir = await makeTempDir();
    const file = await writeYaml(
      dir,
      `database:
  url: postgres://u:p@host:5432/db
server:
  mcp:
    http:
      enabled: true
      auth:
        resource: https://mcp.example.com/mcp
        authorizationServers:
          - https://as.example.com
        jwt:
          jwksUri: https://as.example.com/jwks
`,
    );
    let thrown: unknown;
    try {
      await loadConfig({ path: file, env: { KOZOU_MCP_HTTP_ENABLED: 'false' } });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(KozouConfigError);
    expect((thrown as KozouConfigError).envSources).toEqual(['KOZOU_MCP_HTTP_ENABLED']);
    expect((thrown as KozouConfigError).filePath).toBe(file);
  });

  it('does not record an env var whose value the config ignored', async () => {
    // DATABASE_URL is set but the file supplies a url, so it contributed
    // nothing — naming it would be a false lead of the opposite kind.
    const dir = await makeTempDir();
    const file = await writeYaml(
      dir,
      `database:
  url: postgres://u:p@host:5432/db
server:
  mcp:
    http:
      port: 99999
`,
    );
    let thrown: unknown;
    try {
      await loadConfig({ path: file, env: { DATABASE_URL: 'postgres://other:x@h:5432/y' } });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(KozouConfigError);
    expect((thrown as KozouConfigError).envSources).toEqual([]);
  });

  it('blames the environment, not the config file, for an unreadable value', async () => {
    // The file is read (database.url comes from it) but contains nothing about
    // this variable, so carrying its path would send anyone who reports the
    // location — the CLI does — looking in the wrong place.
    const dir = await makeTempDir();
    const file = await writeYaml(dir, 'database:\n  url: postgres://u:p@host:5432/db\n');
    let thrown: unknown;
    try {
      await loadConfig({ path: file, env: { KOZOU_MCP_HTTP_ENABLED: 'yes' } });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(KozouConfigError);
    expect((thrown as KozouConfigError).filePath).toBeNull();
    expect((thrown as KozouConfigError).issues).toEqual([
      {
        path: 'KOZOU_MCP_HTTP_ENABLED',
        message: 'must be "true" or "false" (unset it to leave the config value in place)',
      },
    ]);
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

  it('treats empty-string auth env vars as unset (auth stays off)', async () => {
    // The scaffold's docker-compose.yml forwards every KOZOU_JWT_* variable
    // with a `${VAR:-}` default, so an unset host variable reaches the
    // container as an empty string. Empty must mean "auth off" — never
    // "HS256 with an empty secret".
    const config = await loadConfig({
      skipFile: true,
      env: {
        DATABASE_URL: 'postgres://u:p@h:5432/db',
        KOZOU_JWT_SECRET: '',
        KOZOU_JWT_PUBLIC_KEY: '',
        KOZOU_JWT_JWKS_URI: '',
        KOZOU_JWT_ALGORITHMS: '',
        KOZOU_JWT_ISSUER: '',
        KOZOU_JWT_AUDIENCE: '',
        KOZOU_JWT_ROLE_CLAIM: '',
        KOZOU_JWT_ALLOWED_ROLES: '',
        KOZOU_JWT_DEFAULT_ROLE: '',
        KOZOU_JWT_ANON_ROLE: '',
        KOZOU_JWT_CLAIMS_GUC: '',
        KOZOU_UI_ROLE: '',
        KOZOU_UI_CLAIMS: '',
        KOZOU_ADAPTER_TOKEN: '',
      },
    });
    expect(config.auth).toBeUndefined();
  });

  it('skips empty-string optional auth env vars when a secret is set', async () => {
    // Same compose shape with only the secret filled in: the other
    // empty-string variables must not produce empty roles / claims (zod
    // would reject min(1)) — they are simply absent.
    const config = await loadConfig({
      skipFile: true,
      env: {
        DATABASE_URL: 'postgres://u:p@h:5432/db',
        KOZOU_JWT_SECRET: 'env-secret',
        KOZOU_JWT_ALGORITHMS: '',
        KOZOU_JWT_ISSUER: '',
        KOZOU_JWT_ROLE_CLAIM: '',
        KOZOU_JWT_ALLOWED_ROLES: '',
        KOZOU_JWT_DEFAULT_ROLE: '',
        KOZOU_JWT_ANON_ROLE: '',
        KOZOU_JWT_CLAIMS_GUC: '',
        KOZOU_UI_ROLE: '',
        KOZOU_UI_CLAIMS: '',
        KOZOU_ADAPTER_TOKEN: '',
      },
    });
    expect(config.auth?.jwt.secret).toBe('env-secret');
    expect(config.auth?.jwt.algorithms).toBeUndefined();
    expect(config.auth?.jwt.issuer).toBeUndefined();
    expect(config.auth?.roleClaim).toBeUndefined();
    expect(config.auth?.allowedRoles).toBeUndefined();
    expect(config.auth?.defaultRole).toBeUndefined();
    expect(config.auth?.anonRole).toBeUndefined();
    expect(config.auth?.claimsGuc).toBeUndefined();
    expect(config.auth?.ui).toBeUndefined();
  });

  it('parses auth.jwt.jwksUri from the config file', async () => {
    const dir = await makeTempDir();
    const file = await writeYaml(
      dir,
      `database:
  url: postgres://u:p@h:5432/db
auth:
  jwt:
    jwksUri: https://idp.example/.well-known/jwks.json
`,
    );
    const config = await loadConfig({ path: file, env: {} });
    expect(config.auth?.jwt.jwksUri).toBe('https://idp.example/.well-known/jwks.json');
    expect(config.auth?.jwt.secret).toBeUndefined();
  });

  it('parses auth.ui.claims from the config file', async () => {
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
    claims:
      tenant_id: acme
      is_admin: true
`,
    );
    const config = await loadConfig({ path: file, env: {} });
    expect(config.auth?.ui?.claims).toEqual({ tenant_id: 'acme', is_admin: true });
  });

  it('parses YAML non-finite literals in claims verbatim (NaN / Infinity reach the resolver)', async () => {
    // Sanity for the resolver's Number.isFinite guard: the YAML loader
    // really does produce these values from `.nan` / `.inf`.
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
    claims:
      exp: .inf
      nbf: .nan
`,
    );
    const config = await loadConfig({ path: file, env: {} });
    expect(config.auth?.ui?.claims?.exp).toBe(Number.POSITIVE_INFINITY);
    expect(Number.isNaN(config.auth?.ui?.claims?.nbf)).toBe(true);
  });

  it('builds auth.ui.claims from a KOZOU_UI_CLAIMS JSON object', async () => {
    const config = await loadConfig({
      skipFile: true,
      env: {
        DATABASE_URL: 'postgres://u:p@h:5432/db',
        KOZOU_JWT_SECRET: 'env-secret',
        KOZOU_UI_CLAIMS: '{"tenant_id":"acme","is_admin":true}',
      },
    });
    expect(config.auth?.ui?.claims).toEqual({ tenant_id: 'acme', is_admin: true });
  });

  it('fails loudly when KOZOU_UI_CLAIMS is not valid JSON', async () => {
    await expect(
      loadConfig({
        skipFile: true,
        env: {
          DATABASE_URL: 'postgres://u:p@h:5432/db',
          KOZOU_JWT_SECRET: 'env-secret',
          KOZOU_UI_CLAIMS: '{tenant_id: acme}',
        },
      }),
      // The CLI prints only the top-level message, so the env var must be
      // named there (not just in the structured issues).
    ).rejects.toThrow(/KOZOU_UI_CLAIMS is not valid JSON/);
  });

  it('fails loudly when KOZOU_UI_CLAIMS is JSON but not an object', async () => {
    for (const bad of ['[1,2]', '"acme"', 'null', '42']) {
      await expect(
        loadConfig({
          skipFile: true,
          env: {
            DATABASE_URL: 'postgres://u:p@h:5432/db',
            KOZOU_JWT_SECRET: 'env-secret',
            KOZOU_UI_CLAIMS: bad,
          },
        }),
      ).rejects.toThrow(/KOZOU_UI_CLAIMS must be a JSON object/);
    }
  });

  it('builds auth from KOZOU_JWT_JWKS_URI env alone', async () => {
    const config = await loadConfig({
      skipFile: true,
      env: {
        DATABASE_URL: 'postgres://u:p@h:5432/db',
        KOZOU_JWT_JWKS_URI: 'https://idp.example/.well-known/jwks.json',
      },
    });
    expect(config.auth?.jwt.jwksUri).toBe('https://idp.example/.well-known/jwks.json');
    expect(config.auth?.jwt.secret).toBeUndefined();
    expect(config.auth?.jwt.publicKey).toBeUndefined();
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

describe('resolvePrivilegeRole (#99)', () => {
  async function base(): Promise<KozouConfig> {
    return loadConfig({ skipFile: true, env: { DATABASE_URL: 'postgres://u:p@h:5432/db' } });
  }

  it('returns undefined when respectPrivileges is off (default)', async () => {
    const config = await base();
    expect(config.introspection.respectPrivileges).toBe(false);
    expect(resolvePrivilegeRole(config)).toBeUndefined();
  });

  it('resolves auth.ui.role when respectPrivileges is on', async () => {
    const config: KozouConfig = {
      ...(await base()),
      introspection: { respectPrivileges: true },
      auth: { jwt: { secret: 's' }, ui: { role: 'app_user' } },
    };
    expect(resolvePrivilegeRole(config)).toBe('app_user');
  });

  it('falls back to auth.defaultRole when ui.role is unset', async () => {
    const config: KozouConfig = {
      ...(await base()),
      introspection: { respectPrivileges: true },
      auth: { jwt: { secret: 's' }, defaultRole: 'app_default' },
    };
    expect(resolvePrivilegeRole(config)).toBe('app_default');
  });

  it('introspection.role overrides the auth-derived role', async () => {
    const config: KozouConfig = {
      ...(await base()),
      introspection: { respectPrivileges: true, role: 'explicit_role' },
      auth: { jwt: { secret: 's' }, ui: { role: 'app_user' } },
    };
    expect(resolvePrivilegeRole(config)).toBe('explicit_role');
  });

  it('throws when on but no role can be resolved', async () => {
    const config: KozouConfig = {
      ...(await base()),
      introspection: { respectPrivileges: true },
    };
    expect(() => resolvePrivilegeRole(config)).toThrow(KozouConfigError);
  });

  it('throws when a ready-made token is in play (suppliedToken) without an explicit introspection.role', async () => {
    const config: KozouConfig = {
      ...(await base()),
      introspection: { respectPrivileges: true },
      // defaultRole would otherwise resolve, but the supplied token's role is
      // unknown and may differ — so it must be made explicit.
      auth: { jwt: { publicKey: 'pem' }, defaultRole: 'app_reader' },
    };
    expect(() => resolvePrivilegeRole(config, { suppliedToken: true })).toThrow(KozouConfigError);
  });

  it('accepts a supplied token when introspection.role is explicit', async () => {
    const config: KozouConfig = {
      ...(await base()),
      introspection: { respectPrivileges: true, role: 'app_admin' },
      auth: { jwt: { publicKey: 'pem' }, ui: { token: 'ready.made.jwt' } },
    };
    expect(resolvePrivilegeRole(config, { suppliedToken: true })).toBe('app_admin');
  });

  it('does NOT gate when no token is in play (suppliedToken false) — the mint path resolves auth.ui.role', async () => {
    const config: KozouConfig = {
      ...(await base()),
      introspection: { respectPrivileges: true },
      auth: { jwt: { secret: 's' }, ui: { role: 'app_user' } },
    };
    // The caller (buildAdminUiEnv) only sets suppliedToken on the API path with
    // a real ready-made token; the HS256 mint path passes false.
    expect(resolvePrivilegeRole(config, { suppliedToken: false })).toBe('app_user');
    expect(resolvePrivilegeRole(config)).toBe('app_user');
  });
});

describe('hasReadyMadeToken (#99)', () => {
  async function base(): Promise<KozouConfig> {
    return loadConfig({ skipFile: true, env: { DATABASE_URL: 'postgres://u:p@h:5432/db' } });
  }

  it('is false with no token configured or inherited', async () => {
    expect(hasReadyMadeToken(await base(), {})).toBe(false);
  });

  it('is true when auth.ui.token is configured', async () => {
    const config: KozouConfig = {
      ...(await base()),
      auth: { jwt: { publicKey: 'pem' }, ui: { token: 'ready.made.jwt' } },
    };
    expect(hasReadyMadeToken(config, {})).toBe(true);
  });

  it('is true when KOZOU_ADAPTER_TOKEN is inherited from the environment', async () => {
    expect(hasReadyMadeToken(await base(), { KOZOU_ADAPTER_TOKEN: 'env.jwt' })).toBe(true);
  });

  it('treats an empty token as absent', async () => {
    const config: KozouConfig = {
      ...(await base()),
      auth: { jwt: { publicKey: 'pem' }, ui: { token: '' } },
    };
    expect(hasReadyMadeToken(config, { KOZOU_ADAPTER_TOKEN: '' })).toBe(false);
  });
});

describe('configSchema (exported for docs coverage tooling)', () => {
  // Exported so kozou-site's `gen:docs` can enumerate the config surface from
  // the source of truth and fail when a top-level block is undocumented (the
  // `introspection` block shipped undocumented from v1.3.0 to v1.8.0).
  it('exposes the top-level config blocks via .shape', () => {
    const blocks = Object.keys(configSchema.shape).sort();
    expect(blocks).toEqual(
      ['adapter', 'api', 'auth', 'cache', 'database', 'introspection', 'server', 'uiHints'].sort(),
    );
  });

  it('includes `introspection` so the coverage check can require it to be documented', () => {
    expect(Object.keys(configSchema.shape)).toContain('introspection');
  });
});

describe('server.mcp.http.auth (OAuth 2.1 resource-server block)', () => {
  it('parses the block with scope/adminRefresh defaults', async () => {
    const dir = await makeTempDir();
    const file = await writeYaml(
      dir,
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
        '          jwksUri: https://as.example.com/jwks',
      ].join('\n'),
    );
    const config = await loadConfig({ path: file, env: {} });
    const auth = config.server.mcp.http.auth;
    expect(auth).toBeDefined();
    expect(auth?.resource).toBe('https://mcp.example.com/mcp');
    expect(auth?.scopes).toEqual({
      describe: 'mcp:describe',
      execute: 'mcp:execute',
      admin: 'mcp:admin',
    });
    expect(auth?.adminRefresh).toBe(false);
  });

  it('requires resource and a non-empty authorizationServers list', async () => {
    const dir = await makeTempDir();
    const file = await writeYaml(
      dir,
      [
        'database:',
        '  url: postgres://u:p@db:5432/app',
        'server:',
        '  mcp:',
        '    http:',
        '      auth:',
        '        resource: https://mcp.example.com/mcp',
        '        authorizationServers: []',
      ].join('\n'),
    );
    await expect(loadConfig({ path: file, env: {} })).rejects.toThrow(KozouConfigError);
  });

  it('execution without a role parses when the auth block is present (per-token role)', async () => {
    const dir = await makeTempDir();
    const file = await writeYaml(
      dir,
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
        '        allowedRoles: [app_agent]',
        '    execution:',
        '      enabled: true',
      ].join('\n'),
    );
    const config = await loadConfig({ path: file, env: {} });
    expect(config.server.mcp.execution.enabled).toBe(true);
    expect(config.server.mcp.execution.role).toBeUndefined();
  });

  it('execution with the auth block requires a non-empty allowedRoles allowlist', async () => {
    const dir = await makeTempDir();
    const yamlFor = (allowedRolesLine: string | null): string[] => [
      'database:',
      '  url: postgres://u:p@db:5432/app',
      'server:',
      '  mcp:',
      '    http:',
      '      auth:',
      '        resource: https://mcp.example.com/mcp',
      '        authorizationServers:',
      '          - https://as.example.com',
      ...(allowedRolesLine === null ? [] : [allowedRolesLine]),
      '    execution:',
      '      enabled: true',
    ];
    // Absent and explicitly empty are both rejected: the token's role claim
    // selects the execution role, so the allowlist must be real.
    for (const allowedRolesLine of [null, '        allowedRoles: []']) {
      const file = await writeYaml(dir, yamlFor(allowedRolesLine).join('\n'));
      try {
        await loadConfig({ path: file, env: {} });
        expect.unreachable('loadConfig should have rejected');
      } catch (err) {
        const e = err as KozouConfigError;
        expect(e).toBeInstanceOf(KozouConfigError);
        expect(
          e.issues.some(
            (i) =>
              i.path === 'server.mcp.http.auth.allowedRoles' &&
              /non-empty allowedRoles/.test(i.message),
          ),
        ).toBe(true);
      }
    }
  });

  it('an inherited empty allowlist points the issue at the top-level auth block', async () => {
    const dir = await makeTempDir();
    const file = await writeYaml(
      dir,
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
        '    execution:',
        '      enabled: true',
        'auth:',
        '  jwt:',
        '    secret: s3cr3t',
        '  allowedRoles: []',
      ].join('\n'),
    );
    try {
      await loadConfig({ path: file, env: {} });
      expect.unreachable('loadConfig should have rejected');
    } catch (err) {
      const e = err as KozouConfigError;
      expect(e).toBeInstanceOf(KozouConfigError);
      // The failing value lives in the top-level auth block — the issue
      // path must send the operator there, not to the nested MCP block.
      expect(
        e.issues.some(
          (i) => i.path === 'auth.allowedRoles' && /non-empty allowedRoles/.test(i.message),
        ),
      ).toBe(true);
    }
  });

  it('the allowedRoles requirement is satisfied by top-level auth inheritance', async () => {
    const dir = await makeTempDir();
    const file = await writeYaml(
      dir,
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
        '    execution:',
        '      enabled: true',
        'auth:',
        '  jwt:',
        '    secret: s3cr3t',
        '  allowedRoles: [app_viewer]',
      ].join('\n'),
    );
    const config = await loadConfig({ path: file, env: {} });
    expect(config.server.mcp.execution.enabled).toBe(true);
  });

  it('the allowedRoles requirement does not apply without execution', async () => {
    const dir = await makeTempDir();
    const file = await writeYaml(
      dir,
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
      ].join('\n'),
    );
    const config = await loadConfig({ path: file, env: {} });
    expect(config.server.mcp.http.auth?.allowedRoles).toBeUndefined();
  });

  it('execution without a role still fails without the auth block (fixed role required)', async () => {
    const dir = await makeTempDir();
    const file = await writeYaml(
      dir,
      [
        'database:',
        '  url: postgres://u:p@db:5432/app',
        'server:',
        '  mcp:',
        '    execution:',
        '      enabled: true',
      ].join('\n'),
    );
    try {
      await loadConfig({ path: file, env: {} });
      expect.unreachable('loadConfig should have rejected');
    } catch (err) {
      const e = err as KozouConfigError;
      expect(e).toBeInstanceOf(KozouConfigError);
      expect(e.issues.some((i) => /execution\.role is required/.test(i.message))).toBe(true);
    }
  });
});

describe('resolveMcpAuthOptions (D2 inheritance)', () => {
  async function configFrom(yaml: string[]): Promise<KozouConfig> {
    const dir = await makeTempDir();
    const file = await writeYaml(dir, yaml.join('\n'));
    return loadConfig({ path: file, env: {} });
  }

  const authBlock = [
    'server:',
    '  mcp:',
    '    http:',
    '      auth:',
    '        resource: https://mcp.example.com/mcp',
    '        authorizationServers:',
    '          - https://as.example.com',
  ];

  it('returns undefined when the block is absent', async () => {
    const config = await configFrom(['database:', '  url: postgres://u:p@db:5432/app']);
    expect(resolveMcpAuthOptions(config)).toBeUndefined();
  });

  it('inherits jwt / roleClaim / allowedRoles from the top-level auth block — audience excepted', async () => {
    const config = await configFrom([
      'database:',
      '  url: postgres://u:p@db:5432/app',
      ...authBlock,
      'auth:',
      '  jwt:',
      '    jwksUri: https://as.example.com/jwks',
      '    issuer: https://as.example.com',
      '    audience: rest-client-id',
      '  roleClaim: db_role',
      '  allowedRoles: [app_viewer, app_admin]',
    ]);
    const opts = resolveMcpAuthOptions(config);
    expect(opts?.jwt.jwksUri).toBe('https://as.example.com/jwks');
    expect(opts?.jwt.issuer).toBe('https://as.example.com');
    // The REST audience (a client id) must never carry over: the MCP token
    // audience is the canonical resource URI (applied downstream by default).
    expect(opts?.jwt.audience).toBeUndefined();
    expect(opts?.roleClaim).toBe('db_role');
    expect(opts?.allowedRoles).toEqual(['app_viewer', 'app_admin']);
  });

  it('the MCP block’s own jwt / roleClaim / allowedRoles win over inherited ones', async () => {
    const config = await configFrom([
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
      '          jwksUri: https://mcp-as.example.com/jwks',
      '          audience: https://mcp.example.com/mcp',
      '        roleClaim: mcp_role',
      '        allowedRoles: [app_viewer]',
      'auth:',
      '  jwt:',
      '    jwksUri: https://as.example.com/jwks',
      '  roleClaim: db_role',
      '  allowedRoles: [app_admin]',
    ]);
    const opts = resolveMcpAuthOptions(config);
    expect(opts?.jwt.jwksUri).toBe('https://mcp-as.example.com/jwks');
    expect(opts?.jwt.audience).toBe('https://mcp.example.com/mcp');
    expect(opts?.roleClaim).toBe('mcp_role');
    expect(opts?.allowedRoles).toEqual(['app_viewer']);
  });

  it('fails fast when no JWT verification material exists in either block', async () => {
    const config = await configFrom(['database:', '  url: postgres://u:p@db:5432/app', ...authBlock]);
    expect(() => resolveMcpAuthOptions(config)).toThrow(/JWT verification config/);
  });

  it('passes scopes / extraScopesSupported / adminRefresh through', async () => {
    const config = await configFrom([
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
      '          secret: s3cr3t',
      '        extraScopesSupported: [offline_access]',
      '        adminRefresh: true',
    ]);
    const opts = resolveMcpAuthOptions(config);
    expect(opts?.extraScopesSupported).toEqual(['offline_access']);
    expect(opts?.adminRefresh).toBe(true);
    expect(opts?.scopes).toEqual({
      describe: 'mcp:describe',
      execute: 'mcp:execute',
      admin: 'mcp:admin',
    });
    // The transport-security opt-out defaults off and is always passed down.
    expect(opts?.allowInsecureHttp).toBe(false);
  });

  it('passes allowInsecureHttp through when set', async () => {
    const config = await configFrom([
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
      '          secret: s3cr3t',
      '        allowInsecureHttp: true',
    ]);
    expect(resolveMcpAuthOptions(config)?.allowInsecureHttp).toBe(true);
  });
});
