// Playwright globalSetup for the `kozou dev --adapter api` E2E suite
// (Kozou v0.2 CLI integration). Proves the headline experience: a single
// `kozou dev --adapter api` brings up both the Admin UI and the in-house
// @kozou/api data backend, with the UI wired to the API — no separate
// data-backend container.
//
// Steps:
//   1. postgres:16 via @testcontainers/postgresql
//   2. fixture schema + seed rows applied with `pg`
//   3. a temp kozou.config.yaml (ports/host literal, db url via ${VAR}),
//      then `kozou dev --config <tmp> --adapter api` spawned with
//      DATABASE_URL / ORIGIN in its environment
//
// `kozou dev` introspects the database and starts @kozou/api in-process,
// then spawns the bundled Admin UI pointed at it. The kozou `dist/cli.js`
// build and the @kozou/svelte-ui `build/` output must both exist first.

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
// Reuse the default-adapter suite's fixture (same schema + seed rows).
const FIXTURE_SQL_PATH = resolve(packageRoot, 'e2e/fixture.sql');

const UI_PORT = 3435; // 3433 is the default-adapter suite's UI port
const MCP_PORT = 3436;
const API_PORT = 3437;
const HOST = '127.0.0.1';
const ORIGIN = `http://${HOST}:${UI_PORT}`;

const CLI_ENTRY = resolve(packageRoot, 'dist/cli.js');
const ADMIN_UI_BUILD = resolve(repoRoot, 'packages/svelte-ui/build/index.js');

function log(msg: string) {
  console.log(`[kozou-e2e-api setup] ${msg}`);
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

  log('applying fixture.sql (schema + seed)');
  const client = new Client({ connectionString: pgUri });
  await client.connect();
  try {
    await client.query(readFileSync(FIXTURE_SQL_PATH, 'utf8'));
  } finally {
    await client.end();
  }

  // kozou.config.yaml: ports/host literal; db url via ${VAR} expansion so
  // the container-assigned host port stays out of the file (and exercises
  // the config loader's env expansion). The adapter block is omitted —
  // --adapter api ignores it and the in-house server connects directly.
  const configDir = mkdtempSync(join(tmpdir(), 'kozou-e2e-api-'));
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
      '',
    ].join('\n'),
    'utf8',
  );
  state.configDir = configDir;

  log(`spawning kozou dev --adapter api — UI ${HOST}:${UI_PORT}, API ${HOST}:${API_PORT}`);
  state.kozouDev = spawn(
    'node',
    [CLI_ENTRY, 'dev', '--config', configPath, '--adapter', 'api', '--api-port', String(API_PORT)],
    {
      cwd: packageRoot,
      env: { ...process.env, DATABASE_URL: pgUri, ORIGIN },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  state.kozouDev.stdout.on('data', (b: Buffer) => process.stdout.write(`[kozou dev] ${b}`));
  state.kozouDev.stderr.on('data', (b: Buffer) => process.stderr.write(`[kozou dev] ${b}`));

  log(`waiting for Admin UI at ${ORIGIN}/`);
  await waitForHttp(`${ORIGIN}/`, 60_000);
  log('all services up');
}
