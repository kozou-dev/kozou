// Playwright globalSetup: bring up the full stack the Admin UI talks to.
//
// 1. postgres:16 via @testcontainers/postgresql
// 2. fixture schema + seed rows applied with `pg`
// 3. postgrest/postgrest as a sibling container on a shared docker network
// 4. svelte-ui (`node build/index.js`) as a child process with
//    `DATABASE_URL` + `KOZOU_ADAPTER_URL` pointing at the above
//
// The svelte-ui build has to exist before the suite runs - either through
// `pnpm --filter @kozou/svelte-ui run build` locally or the CI job's
// build step. The check at the top of this script fails fast with a
// human-readable hint when it's missing.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import { dirname, resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { GenericContainer, Network, Wait } from 'testcontainers';

import { state } from './state.js';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '../..');
const FIXTURE_SQL_PATH = resolve(here, '../fixture.sql');
const SVELTE_UI_PORT = 4173;
const SVELTE_UI_HOST = '127.0.0.1';
const POSTGREST_IMAGE = 'postgrest/postgrest:v12.2.0';
const POSTGREST_PORT = 3000;

function log(msg: string) {
  console.log(`[e2e setup] ${msg}`);
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
  throw new Error(
    `HTTP server at ${url} did not respond within ${timeoutMs}ms`,
  );
}

export default async function globalSetup() {
  const buildEntry = resolve(packageRoot, 'build/index.js');
  if (!existsSync(buildEntry)) {
    throw new Error(
      `svelte-ui build artifact missing at ${buildEntry}. ` +
        'Run `pnpm --filter @kozou/svelte-ui run build` before `pnpm test:e2e`.',
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

  log(`starting postgrest (${POSTGREST_IMAGE})`);
  state.postgrest = await new GenericContainer(POSTGREST_IMAGE)
    .withNetwork(state.network)
    .withExposedPorts(POSTGREST_PORT)
    .withEnvironment({
      // db is the network alias for the postgres container above; using
      // the alias instead of localhost avoids leaking the host port to
      // the postgrest sidecar.
      PGRST_DB_URI: `postgres://${state.postgres.getUsername()}:${state.postgres.getPassword()}@db:5432/${state.postgres.getDatabase()}`,
      PGRST_DB_ANON_ROLE: 'web_anon',
      PGRST_DB_SCHEMAS: 'public',
    })
    .withWaitStrategy(Wait.forHttp('/', POSTGREST_PORT))
    .start();

  const postgrestUrl = `http://${state.postgrest.getHost()}:${state.postgrest.getMappedPort(POSTGREST_PORT)}`;
  log(`postgrest ready at ${postgrestUrl}`);

  log(`spawning svelte-ui (node build/index.js) on ${SVELTE_UI_HOST}:${SVELTE_UI_PORT}`);
  const svelteUi = spawn('node', ['build/index.js'], {
    cwd: packageRoot,
    env: {
      ...process.env,
      DATABASE_URL: state.postgres.getConnectionUri(),
      KOZOU_ADAPTER_URL: postgrestUrl,
      PORT: String(SVELTE_UI_PORT),
      HOST: SVELTE_UI_HOST,
      // adapter-node assumes https when neither ORIGIN nor
      // PROTOCOL_HEADER is set, so its computed request origin becomes
      // `https://127.0.0.1:4173` while the browser sends an
      // `http://127.0.0.1:4173` Origin header. SvelteKit's CSRF guard
      // then rejects every POST form action with a 403
      // "Cross-site POST form submissions are forbidden", which breaks
      // the create / edit / delete flows this suite exercises. Setting
      // ORIGIN to the real plain-http URL aligns the two so the
      // mutation specs reach the actual server actions. Any plain-http
      // adapter-node deployment of the Admin UI (e.g. `kozou dev` on
      // http://localhost:3333) needs the same — tracked as a v0.1.1
      // follow-up.
      ORIGIN: `http://${SVELTE_UI_HOST}:${SVELTE_UI_PORT}`,
      NODE_ENV: 'production',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  state.svelteUi = svelteUi;
  svelteUi.stdout.on('data', (b: Buffer) =>
    process.stdout.write(`[svelte-ui] ${b}`),
  );
  svelteUi.stderr.on('data', (b: Buffer) =>
    process.stderr.write(`[svelte-ui] ${b}`),
  );

  log(`waiting for svelte-ui at http://${SVELTE_UI_HOST}:${SVELTE_UI_PORT}/`);
  await waitForHttp(`http://${SVELTE_UI_HOST}:${SVELTE_UI_PORT}/`, 30_000);
  log('all services up');
}
