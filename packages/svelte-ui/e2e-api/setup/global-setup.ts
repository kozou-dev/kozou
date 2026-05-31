// Playwright globalSetup for the @kozou/api seam-swap suite (Kozou v0.2
// Phase 4b). Brings up the full stack the Admin UI talks to when the
// in-house API layer is selected:
//
//   1. postgres:16 via @testcontainers/postgresql
//   2. fixture schema + seed rows applied with `pg`
//   3. @kozou/api started in-process (introspect -> buildSchemaContext ->
//      startApiServer against a pg Pool) — the in-house backend, run with
//      no external backend container
//   4. svelte-ui (`node build/index.js`) as a child process with
//      KOZOU_ADAPTER_KIND=api + KOZOU_ADAPTER_URL pointing at @kozou/api
//
// The point of the suite: the same Admin UI build, with only the adapter
// swapped via env, drives a full browser CRUD loop against @kozou/api
// (the Kozou v0.2 DoD). It reuses e2e/fixture.sql so the seeded data and
// the spec assertions match the sibling e2e/ suite.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import { dirname, resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';

import { buildSchemaContext } from '@kozou/core';
import { introspect } from '@kozou/introspect';
import { startApiServer, type Queryable } from '@kozou/api';

import { state } from './state.js';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '../..');
// Reuse the sibling e2e/ suite's fixture: same schema + seed rows. Its
// extra role / grants are inert here (the API connects as the container
// superuser), but keeping one fixture keeps the two suites' assertions in
// lockstep.
const FIXTURE_SQL_PATH = resolve(packageRoot, 'e2e/fixture.sql');
const SVELTE_UI_PORT = 4174; // 4173 is the sibling e2e/ suite's port
const SVELTE_UI_HOST = '127.0.0.1';

function log(msg: string) {
  console.log(`[e2e-api setup] ${msg}`);
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
  const buildEntry = resolve(packageRoot, 'build/index.js');
  if (!existsSync(buildEntry)) {
    throw new Error(
      `svelte-ui build artifact missing at ${buildEntry}. ` +
        'Run `pnpm --filter @kozou/svelte-ui run build` before `pnpm test:e2e:api`.',
    );
  }

  log('starting postgres:16');
  state.postgres = await new PostgreSqlContainer('postgres:16').start();
  const pgUri = state.postgres.getConnectionUri();

  log('applying fixture.sql (schema + seed)');
  const client = new pg.Client({ connectionString: pgUri });
  await client.connect();
  try {
    await client.query(readFileSync(FIXTURE_SQL_PATH, 'utf8'));
  } finally {
    await client.end();
  }

  log('introspecting + starting @kozou/api in-process');
  const raw = await introspect({ connection: pgUri });
  const schema = await buildSchemaContext({ raw });
  state.pool = new pg.Pool({ connectionString: pgUri });
  const pool = state.pool;
  const db: Queryable = {
    query: (text: string, values?: unknown[]) => pool.query(text, values),
  };
  state.api = await startApiServer({ schema, db, host: '127.0.0.1', port: 0 });
  const apiUrl = `http://127.0.0.1:${state.api.port}`;
  log(`@kozou/api ready at ${apiUrl}`);

  log(`spawning svelte-ui on ${SVELTE_UI_HOST}:${SVELTE_UI_PORT} (KOZOU_ADAPTER_KIND=api)`);
  state.svelteUi = spawn('node', ['build/index.js'], {
    cwd: packageRoot,
    env: {
      ...process.env,
      DATABASE_URL: pgUri,
      KOZOU_ADAPTER_KIND: 'api',
      KOZOU_ADAPTER_URL: apiUrl,
      PORT: String(SVELTE_UI_PORT),
      HOST: SVELTE_UI_HOST,
      // Same plain-http CSRF alignment the sibling e2e/ suite documents:
      // adapter-node assumes https without ORIGIN, so the computed origin
      // would mismatch the browser's http Origin and SvelteKit's CSRF
      // guard would 403 every form POST.
      ORIGIN: `http://${SVELTE_UI_HOST}:${SVELTE_UI_PORT}`,
      NODE_ENV: 'production',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  state.svelteUi.stdout.on('data', (b: Buffer) =>
    process.stdout.write(`[svelte-ui] ${b}`),
  );
  state.svelteUi.stderr.on('data', (b: Buffer) =>
    process.stderr.write(`[svelte-ui] ${b}`),
  );

  log(`waiting for svelte-ui at http://${SVELTE_UI_HOST}:${SVELTE_UI_PORT}/`);
  await waitForHttp(`http://${SVELTE_UI_HOST}:${SVELTE_UI_PORT}/`, 30_000);
  log('all services up');
}
