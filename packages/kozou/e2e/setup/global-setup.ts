// Playwright globalSetup: bring up the full stack `kozou dev` wires together.
//
// Unlike the @kozou/svelte-ui E2E suite (which spawns the Admin UI server
// directly), this suite launches `node dist/cli.js dev` so the dev
// command's own wiring is exercised end to end against a real stack:
//   - config -> child-process env mapping
//   - ORIGIN propagation to the Admin UI child (so plain-http form POSTs
//     are not rejected by the CSRF guard)
//   - the MCP Streamable HTTP server, started in-process
//   - both surfaces brought up together under one process
//
// Steps:
//   1. postgres:16 via @testcontainers/postgresql
//   2. fixture schema + seed rows applied with `pg`
//   3. the REST-adapter sidecar on a shared docker network
//   4. a temp kozou.config.yaml (ports/host literal, urls via ${VAR}
//      expansion), then `kozou dev --config <tmp>` spawned with
//      DATABASE_URL / KOZOU_ADAPTER_URL / ORIGIN in its environment
//
// Both the kozou `dist/cli.js` build and the @kozou/svelte-ui `build/`
// output must exist before the suite runs (the dev command spawns the
// latter). The checks below fail fast with a human-readable hint when
// either is missing.

import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { GenericContainer, Network, Wait } from 'testcontainers';

import { state } from './state.js';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '../..'); // packages/kozou
const repoRoot = resolve(packageRoot, '../..'); // repository root
const FIXTURE_SQL_PATH = resolve(here, '../fixture.sql');

const UI_PORT = 3433;
const MCP_PORT = 3434;
const HOST = '127.0.0.1';
const ORIGIN = `http://${HOST}:${UI_PORT}`;

// Public Docker image tag for the SQL-to-REST adapter sidecar.
const ADAPTER_IMAGE = 'postgrest/postgrest:v12.2.0';
const ADAPTER_PORT = 3000;

const CLI_ENTRY = resolve(packageRoot, 'dist/cli.js');
const ADMIN_UI_BUILD = resolve(repoRoot, 'packages/svelte-ui/build/index.js');

function log(msg: string) {
  console.log(`[kozou-e2e setup] ${msg}`);
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
      `kozou CLI build missing at ${CLI_ENTRY}. ` +
        'Run `pnpm -r run build` before `pnpm --filter kozou test:e2e`.',
    );
  }
  if (!existsSync(ADMIN_UI_BUILD)) {
    throw new Error(
      `@kozou/svelte-ui build missing at ${ADMIN_UI_BUILD}. ` +
        '`kozou dev` spawns it, so run `pnpm -r run build` first.',
    );
  }

  log('creating docker network');
  state.network = await new Network().start();

  log('starting postgres:16');
  state.postgres = await new PostgreSqlContainer('postgres:16')
    .withNetwork(state.network)
    .withNetworkAliases('db')
    .start();

  log('applying fixture.sql (schema + seed + grants)');
  const fixtureSql = readFileSync(FIXTURE_SQL_PATH, 'utf8');
  const client = new Client({
    connectionString: state.postgres.getConnectionUri(),
  });
  await client.connect();
  try {
    await client.query(fixtureSql);
  } finally {
    await client.end();
  }

  log(`starting REST adapter (${ADAPTER_IMAGE})`);
  state.adapter = await new GenericContainer(ADAPTER_IMAGE)
    .withNetwork(state.network)
    .withExposedPorts(ADAPTER_PORT)
    .withEnvironment({
      // `db` is the network alias for the postgres container above; using
      // the alias instead of localhost avoids leaking the host port to
      // the adapter sidecar.
      PGRST_DB_URI: `postgres://${state.postgres.getUsername()}:${state.postgres.getPassword()}@db:5432/${state.postgres.getDatabase()}`,
      PGRST_DB_ANON_ROLE: 'web_anon',
      PGRST_DB_SCHEMAS: 'public',
    })
    .withWaitStrategy(Wait.forHttp('/', ADAPTER_PORT))
    .start();

  const adapterUrl = `http://${state.adapter.getHost()}:${state.adapter.getMappedPort(ADAPTER_PORT)}`;
  log(`REST adapter ready at ${adapterUrl}`);

  // Generate a kozou.config.yaml. Ports/host are literal (no env override
  // exists for them); the database / adapter URLs use ${VAR} expansion so
  // the container-assigned host ports stay out of the file and the dev
  // command's config loader (incl. ${VAR} expansion) is itself dogfooded.
  // adapter.type defaults to its only allowed value, so it is omitted.
  const configDir = mkdtempSync(join(tmpdir(), 'kozou-e2e-'));
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
      'adapter:',
      '  url: ${KOZOU_ADAPTER_URL}',
      '',
    ].join('\n'),
    'utf8',
  );
  state.configDir = configDir;

  log(
    `spawning kozou dev (node dist/cli.js dev) — UI ${HOST}:${UI_PORT}, MCP ${HOST}:${MCP_PORT}`,
  );
  state.kozouDev = spawn('node', [CLI_ENTRY, 'dev', '--config', configPath], {
    cwd: packageRoot,
    env: {
      ...process.env,
      DATABASE_URL: state.postgres.getConnectionUri(),
      KOZOU_ADAPTER_URL: adapterUrl,
      // The Admin UI is an adapter-node server; without a matching ORIGIN
      // it assumes https and rejects plain-http form POSTs with a 403.
      // `kozou dev` propagates this ORIGIN to the spawned UI child.
      ORIGIN,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  state.kozouDev.stdout.on('data', (b: Buffer) =>
    process.stdout.write(`[kozou dev] ${b}`),
  );
  state.kozouDev.stderr.on('data', (b: Buffer) =>
    process.stderr.write(`[kozou dev] ${b}`),
  );

  log(`waiting for Admin UI at ${ORIGIN}/`);
  await waitForHttp(`${ORIGIN}/`, 60_000);
  // The MCP server starts before the UI child in `kozou dev`, so it is
  // already listening by now; probe it anyway to fail fast if not. A
  // session-less GET to /mcp returns 400 (< 500), which is "reachable".
  log(`waiting for MCP HTTP at http://${HOST}:${MCP_PORT}/mcp`);
  await waitForHttp(`http://${HOST}:${MCP_PORT}/mcp`, 30_000);
  log('all services up');
}
