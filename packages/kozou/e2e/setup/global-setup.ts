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
//   5. a second `kozou dev` against the same backend with
//      `server.mcp.http.enabled: false`, so the opted-out runtime — no
//      listener, /connect 404, no MCP nav entry — is exercised end to end.
//      Same database, same adapter, same build; the only other differences
//      are the two ports it cannot share.
//
// Both the kozou `dist/cli.js` build and the @kozou/svelte-ui `build/`
// output must exist *and be no older than their sources* before the suite
// runs (the dev command spawns the latter). Checking only for existence
// meant a local run could pass green against a build from before the change
// under test; the checks below fail fast with a human-readable hint instead.

import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
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

// The opted-out stack: a second `kozou dev` against the same database and
// adapter, differing in `server.mcp.http.enabled` (and necessarily in the
// ports, which must not collide). It starts no MCP listener at all, so
// MCP_PORT_MCP_OFF is the port the specs assert is *not* served.
//
// The suites divide the range by hand and each block says what precedes it:
// 3433-3434 here, 3435-3437 e2e-api, 3445-3447 e2e-api-auth. 3438-3439 is
// the first free pair after e2e-api's block. Taking 3435/3436 — as the
// first version of this did — puts two suites on one port, and because each
// suite is its own CI job the collision only ever appears locally, as the
// opted-out UI silently answering from the *other* suite's MCP-enabled
// server.
const UI_PORT_MCP_OFF = 3438;
const MCP_PORT_MCP_OFF = 3439;
const ORIGIN_MCP_OFF = `http://${HOST}:${UI_PORT_MCP_OFF}`;

// Handed to the specs rather than repeated there: a spec that hardcodes the
// MCP port and drifts from this one still "passes", because an unrelated
// free port also refuses connections. That is the one assertion whose whole
// value rests on the port being the declared one.
const PORT_ENV = {
  ui: 'KOZOU_E2E_MCP_OFF_UI_PORT',
  mcp: 'KOZOU_E2E_MCP_OFF_MCP_PORT',
} as const;

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

/** Newest mtime under a directory. `skip` names entries to ignore at every
 *  level; a symlinked entry is measured but never recursed into (lstat
 *  semantics via Dirent, so a link cannot smuggle an unmeasured subtree in
 *  and cannot be followed out of the tree either). */
function newestMtime(dir: string, skip: ReadonlySet<string>): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(entry.name) || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestMtime(full, skip));
    } else {
      // A broken symlink would throw from statSync; it is not a source file
      // whose freshness we can judge, so it is skipped rather than fatal.
      try {
        newest = Math.max(newest, statSync(full).mtimeMs);
      } catch {
        continue;
      }
    }
  }
  return newest;
}

/** A copy of the environment with the MCP HTTP overrides removed. Both
 *  stacks are defined by their generated config; letting an inherited
 *  KOZOU_MCP_HTTP_* win would make the suite's result depend on the shell it
 *  was started from. */
function withoutMcpHttpEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => !name.startsWith('KOZOU_MCP_HTTP_')),
  );
}

const SOURCE_SKIP = new Set(['node_modules', 'dist', 'build']);
const OUTPUT_SKIP = new Set(['node_modules']);

/** Fail when any workspace package's build is missing or older than its own
 *  sources.
 *
 *  Checking only that the two spawned entrypoints *exist* meant a local run
 *  exercised whatever those directories happened to contain: the suite could
 *  pass green against a build from before the change under test, which is
 *  worse than not running it. Two entrypoints is also not enough — `kozou
 *  dev` loads @kozou/{api,core,introspect,mcp} and the Admin UI loads
 *  @kozou/{core,introspect,ui-core}, all as built output, so editing
 *  `packages/mcp/src` and skipping the rebuild left exactly the same hazard
 *  for the code this suite is closest to.
 *
 *  Packages are discovered rather than listed, so a new one is covered the
 *  day it appears. Freshness compares the newest mtime under the *output*
 *  tree, not one entrypoint file: with `incremental` builds an unchanged
 *  entrypoint is not re-emitted, which would freeze its mtime while its
 *  siblings move.
 *
 *  CI builds first, so this only ever fires locally. */
function requireCurrentBuilds(): void {
  const packagesDir = resolve(repoRoot, 'packages');
  for (const name of readdirSync(packagesDir).sort()) {
    const packageDir = join(packagesDir, name);
    const sourceDir = join(packageDir, 'src');
    const manifestPath = join(packageDir, 'package.json');
    if (!existsSync(sourceDir) || !existsSync(manifestPath)) continue;
    // Having a `src` is not the same as producing a build: @kozou/test-utils
    // is consumed from source by the unit suites and emits nothing, so
    // demanding output from it fails a correct tree. The build script is what
    // says "this package ships compiled output".
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      scripts?: Record<string, string>;
    };
    if (typeof manifest.scripts?.['build'] !== 'string') continue;
    const outputDir = ['dist', 'build']
      .map((candidate) => join(packageDir, candidate))
      .find((candidate) => existsSync(candidate));
    if (outputDir === undefined) {
      throw new Error(
        `@kozou/${name} declares a build script but has no build output. This suite ` +
          'runs the built packages, so run `pnpm -r run build` before ' +
          '`pnpm --filter kozou test:e2e`.',
      );
    }
    if (newestMtime(sourceDir, SOURCE_SKIP) > newestMtime(outputDir, OUTPUT_SKIP)) {
      throw new Error(
        `@kozou/${name}'s build in ${outputDir} is older than its sources. This suite ` +
          'would be testing the previous build, so a green run would say nothing ' +
          'about the working tree. Run `pnpm -r run build` first.',
      );
    }
  }
  // The two the suite spawns directly, named for a clearer failure than a
  // missing-file crash deep in the spawn.
  for (const [entry, what] of [
    [CLI_ENTRY, 'kozou CLI'],
    [ADMIN_UI_BUILD, '@kozou/svelte-ui (`kozou dev` spawns it)'],
  ] as const) {
    if (!existsSync(entry)) {
      throw new Error(
        `${what} build missing at ${entry}. ` +
          'Run `pnpm -r run build` before `pnpm --filter kozou test:e2e`.',
      );
    }
  }
}

export default async function globalSetup() {
  requireCurrentBuilds();

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
  // This suite pins the external REST opt-out via adapter.type so `kozou dev`
  // (no flag) selects it — exercising config-driven adapter selection and the
  // opt-out path against the sidecar above.
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
      '  type: postgrest',
      '  url: ${KOZOU_ADAPTER_URL}',
      '',
    ].join('\n'),
    'utf8',
  );
  state.configDir = configDir;

  log(
    `spawning kozou dev (node dist/cli.js dev) — UI ${HOST}:${UI_PORT}, MCP ${HOST}:${MCP_PORT}`,
  );
  const kozouDev = spawn('node', [CLI_ENTRY, 'dev', '--config', configPath], {
    cwd: packageRoot,
    env: {
      ...withoutMcpHttpEnv(process.env),
      DATABASE_URL: state.postgres.getConnectionUri(),
      KOZOU_ADAPTER_URL: adapterUrl,
      // The Admin UI is an adapter-node server; without a matching ORIGIN
      // it assumes https and rejects plain-http form POSTs with a 403.
      // `kozou dev` propagates this ORIGIN to the spawned UI child.
      ORIGIN,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  state.kozouDev = kozouDev;
  kozouDev.stdout.on('data', (b: Buffer) => process.stdout.write(`[kozou dev] ${b}`));
  kozouDev.stderr.on('data', (b: Buffer) => process.stderr.write(`[kozou dev] ${b}`));

  log(`waiting for Admin UI at ${ORIGIN}/`);
  await waitForHttp(`${ORIGIN}/`, 60_000);
  // The MCP server starts before the UI child in `kozou dev`, so it is
  // already listening by now; probe it anyway to fail fast if not. A
  // session-less GET to /mcp returns 400 (< 500), which is "reachable".
  log(`waiting for MCP HTTP at http://${HOST}:${MCP_PORT}/mcp`);
  await waitForHttp(`http://${HOST}:${MCP_PORT}/mcp`, 30_000);

  // The opted-out runtime. `server.mcp.http.enabled: false` has three
  // observable effects — no listener, a 404 on /connect, and no MCP entry in
  // the Admin UI's nav — and the join between them is what nothing covered:
  // the projection is unit-tested on both sides, but not that a real
  // `kozou dev` with the endpoint off produces a UI child that agrees.
  //
  // Same database, same adapter, same build. Beyond the opt-out itself only
  // the two ports differ, and those cannot be shared.
  const configDirMcpOff = mkdtempSync(join(tmpdir(), 'kozou-e2e-mcp-off-'));
  const configPathMcpOff = join(configDirMcpOff, 'kozou.config.yaml');
  writeFileSync(
    configPathMcpOff,
    [
      'database:',
      '  url: ${DATABASE_URL}',
      '  schemas: [public]',
      'server:',
      '  ui:',
      `    port: ${UI_PORT_MCP_OFF}`,
      `    host: ${HOST}`,
      '  mcp:',
      '    http:',
      '      enabled: false',
      // A port is still declared so the specs assert against a port the
      // config names — proving nothing binds it, rather than probing a port
      // the config never mentioned.
      `      port: ${MCP_PORT_MCP_OFF}`,
      `      host: ${HOST}`,
      'adapter:',
      '  type: postgrest',
      '  url: ${KOZOU_ADAPTER_URL}',
      '',
    ].join('\n'),
    'utf8',
  );
  state.configDirMcpOff = configDirMcpOff;

  log(`spawning kozou dev with MCP off — UI ${HOST}:${UI_PORT_MCP_OFF}, no MCP listener`);
  const kozouDevMcpOff = spawn('node', [CLI_ENTRY, 'dev', '--config', configPathMcpOff], {
    cwd: packageRoot,
    env: {
      // KOZOU_MCP_HTTP_* is stripped from both children: those variables
      // override the generated YAML in either direction (config.ts's
      // injectServerOverridesFromEnv), so a developer who happens to export
      // the documented compose knob would flip the very setting under test
      // and get a failure aimed at the product instead of their shell.
      ...withoutMcpHttpEnv(process.env),
      DATABASE_URL: state.postgres.getConnectionUri(),
      KOZOU_ADAPTER_URL: adapterUrl,
      ORIGIN: ORIGIN_MCP_OFF,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  state.kozouDevMcpOff = kozouDevMcpOff;
  kozouDevMcpOff.stdout.on('data', (b: Buffer) => process.stdout.write(`[kozou dev mcp-off] ${b}`));
  kozouDevMcpOff.stderr.on('data', (b: Buffer) => process.stderr.write(`[kozou dev mcp-off] ${b}`));

  log(`waiting for the opted-out Admin UI at ${ORIGIN_MCP_OFF}/`);
  await waitForHttp(`${ORIGIN_MCP_OFF}/`, 60_000);

  // Playwright spawns its workers from this process, so they inherit these.
  process.env[PORT_ENV.ui] = String(UI_PORT_MCP_OFF);
  process.env[PORT_ENV.mcp] = String(MCP_PORT_MCP_OFF);

  log('all services up');
}
