// Playwright globalSetup for the `kozou dev --adapter api` auth E2E suite.
//
// Proves the full authenticated path through the bundled Admin UI:
//   `kozou dev --adapter api` + an `auth:` block
//     -> the CLI mints an HS256 token for the UI claiming `auth.ui.role`
//     -> injects it into the Admin UI child as KOZOU_ADAPTER_TOKEN
//     -> the UI's server-side adapter sends `Authorization: Bearer …`
//     -> @kozou/api verifies it, runs each request under `SET LOCAL ROLE`
//     -> the database's RLS policy filters the rows the UI can see.
//
// Unit + API-layer integration tests cover each side; this exercises the
// assembled seam end to end in a real browser.
//
// Steps:
//   1. postgres:16 via @testcontainers/postgresql
//   2. the shared fixture, then auth DDL (an `owner` column + a hidden row,
//      an `app_admin` role with grants, RLS + a policy exposing owner='admin')
//   3. a temp kozou.config.yaml carrying an `auth:` block (HS256 secret via
//      ${VAR}, allowedRoles, ui.role), then `kozou dev --adapter api` spawned
//      with DATABASE_URL / ORIGIN / KOZOU_JWT_SECRET in its environment.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';

import { state } from './state.js';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '../..'); // packages/kozou
const repoRoot = resolve(packageRoot, '../..');
// Reuse the no-auth suite's fixture (same schema + seed rows); auth DDL is
// layered on top below.
const FIXTURE_SQL_PATH = resolve(packageRoot, 'e2e/fixture.sql');

const UI_PORT = 3445; // 3435 is the no-auth api suite's UI port
const MCP_PORT = 3446;
const API_PORT = 3447;
const HOST = '127.0.0.1';
const ORIGIN = `http://${HOST}:${UI_PORT}`;
// The HS256 secret the API verifies against and the CLI mints the UI token with.
const JWT_SECRET = 'e2e-auth-secret-do-not-use';

const CLI_ENTRY = resolve(packageRoot, 'dist/cli.js');
const ADMIN_UI_BUILD = resolve(repoRoot, 'packages/svelte-ui/build/index.js');

// Layered on top of the shared fixture: an ownership column the RLS policy
// keys on, a row the policy hides, and the role the Admin UI assumes. The
// policy reads the `team` claim from request.jwt.claims (not a literal), so
// the visible rows depend on the custom claim minted into the UI token via
// auth.ui.claims — the suite proves the claims passthrough end to end (if
// the claim does not reach the database, every row disappears).
const AUTH_DDL = `
  ALTER TABLE authors ADD COLUMN owner text NOT NULL DEFAULT 'admin';
  INSERT INTO authors (display_name, owner) VALUES ('Hidden Author', 'other');

  CREATE ROLE app_admin;
  GRANT USAGE ON SCHEMA public TO app_admin;
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_admin;
  GRANT app_admin TO CURRENT_USER;

  ALTER TABLE authors ENABLE ROW LEVEL SECURITY;
  CREATE POLICY authors_admin ON authors FOR ALL TO app_admin
    USING (owner = current_setting('request.jwt.claims', true)::jsonb ->> 'team')
    WITH CHECK (owner = current_setting('request.jwt.claims', true)::jsonb ->> 'team');
`;

function log(msg: string) {
  console.log(`[kozou-e2e-api-auth setup] ${msg}`);
}

async function waitForHttp(url: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve_) => {
      const req = request(url, (response) => {
        response.resume();
        resolve_(response.statusCode != null && response.statusCode < 500);
      });
      req.on('error', () => resolve_(false));
      req.end();
    });
    if (ok) return;
    await wait(500);
  }
  throw new Error(`HTTP server at ${url} did not respond within ${timeoutMs}ms`);
}

export default async function globalSetup() {
  if (!existsSync(CLI_ENTRY)) {
    throw new Error(
      `kozou CLI build missing at ${CLI_ENTRY}. Run \`pnpm -r run build\` first.`,
    );
  }
  if (!existsSync(ADMIN_UI_BUILD)) {
    throw new Error(
      `@kozou/svelte-ui build missing at ${ADMIN_UI_BUILD}. Run \`pnpm -r run build\` first.`,
    );
  }

  log('starting postgres:16');
  state.postgres = await new PostgreSqlContainer('postgres:16').start();
  const pgUri = state.postgres.getConnectionUri();

  log('applying fixture.sql + auth DDL (owner column, app_admin role, RLS policy)');
  const client = new Client({ connectionString: pgUri });
  await client.connect();
  try {
    await client.query(readFileSync(FIXTURE_SQL_PATH, 'utf8'));
    await client.query(AUTH_DDL);
  } finally {
    await client.end();
  }

  // kozou.config.yaml with an auth block. The secret arrives via ${VAR}
  // expansion (verbatim), allowedRoles gates role-switching, ui.role tells
  // the CLI which role to mint the bundled UI's HS256 token for, and
  // ui.claims mints the `team` claim the RLS policy above reads.
  const configDir = mkdtempSync(join(tmpdir(), 'kozou-e2e-api-auth-'));
  const configPath = join(configDir, 'kozou.config.yaml');
  writeFileSync(
    configPath,
    [
      'database:',
      '  url: ${DATABASE_URL}',
      '  schemas: [public]',
      'server:',
      '  ui:',
      `    port: ${UI_PORT}`,
      `    host: ${HOST}`,
      '  mcp:',
      '    http:',
      `      port: ${MCP_PORT}`,
      `      host: ${HOST}`,
      'auth:',
      '  jwt:',
      '    secret: ${KOZOU_JWT_SECRET}',
      '  allowedRoles: [app_admin]',
      '  ui:',
      '    role: app_admin',
      '    claims:',
      '      team: admin',
      '',
    ].join('\n'),
    'utf8',
  );
  state.configDir = configDir;

  log(`spawning kozou dev --adapter api (auth) — UI ${HOST}:${UI_PORT}, API ${HOST}:${API_PORT}`);
  const kozouDev = spawn(
    'node',
    [CLI_ENTRY, 'dev', '--config', configPath, '--adapter', 'api', '--api-port', String(API_PORT)],
    {
      cwd: packageRoot,
      env: { ...process.env, DATABASE_URL: pgUri, ORIGIN, KOZOU_JWT_SECRET: JWT_SECRET },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  state.kozouDev = kozouDev;
  kozouDev.stdout.on('data', (b: Buffer) => process.stdout.write(`[kozou dev] ${b}`));
  kozouDev.stderr.on('data', (b: Buffer) => process.stderr.write(`[kozou dev] ${b}`));

  log(`waiting for Admin UI at ${ORIGIN}/`);
  await waitForHttp(`${ORIGIN}/`, 60_000);
  log('all services up');
}
