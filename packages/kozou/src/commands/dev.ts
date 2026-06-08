// `kozou dev` command implementation.
//
// Brings up the full local runtime described in Kozou v0.1 spec §9.1:
//   - the bundled @kozou/svelte-ui Admin UI, spawned as a child process
//     (`node <svelte-ui>/build/index.js` — the adapter-node standalone
//     server, the same entry the svelte-ui E2E suite exercises);
//   - the MCP Streamable HTTP server, run in-process via @kozou/mcp's
//     startHttpServer (spec §7.1).
//
// Both default to 0.0.0.0 (spec §9.1, so `docker compose` port mapping
// works); a loud warning fires on a non-loopback bind because neither
// surface authenticates in v0.1 (spec §18.5).
//
// The Admin UI is an adapter-node (SvelteKit) server: without ORIGIN it
// assumes https and rejects every form POST over plain http with a 403.
// We default ORIGIN to http://localhost:<ui-port>; override via the
// ORIGIN / KOZOU_ORIGIN env when serving on a different public URL.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

import { SchemaCache, startHttpServer, isLoopbackHost } from '@kozou/mcp';

import { loadConfig, type KozouConfig, ADAPTER_KINDS, type AdapterKind } from '../config.js';
import { PACKAGE_VERSION } from '../version.js';
import {
  buildAdminUiEnv,
  resolveAdminUiEntry,
  resolveAdminUiToken,
  resolveOrigin,
} from './dev-runtime.js';

export type DevOptions = {
  config?: string;
  /** Backend override: an adapter kind from `ADAPTER_KINDS`. When omitted, the
   *  config's `adapter.type` is used (default `api`, the in-house backend). */
  adapter?: string;
  /** Port for the in-house @kozou/api server (used when the backend is `api`). */
  apiPort?: number;
};

const PREFIX = '[kozou dev]';

// The in-house @kozou/api server is reached only by the Admin UI's
// server-side fetch (same host), so bind it to loopback — no need to
// expose it to the browser or the network.
const API_HOST = '127.0.0.1';
const DEFAULT_API_PORT = 3335;

type InhouseApi = { url: string; close: () => Promise<void> };

// Start the in-house @kozou/api server in-process: introspect the
// configured database, build its SchemaContext, and serve it over a pg
// pool. @kozou/api is a runtime dependency of the kozou CLI (the default
// backend), but it is imported dynamically so MCP-only and opt-out runs do
// not load it; a failed import therefore means a broken install.
async function startInhouseApi(config: KozouConfig, port: number): Promise<InhouseApi> {
  let apiModule: typeof import('@kozou/api');
  try {
    apiModule = await import('@kozou/api');
  } catch {
    throw new Error(
      `${PREFIX} could not load @kozou/api, the bundled in-house REST backend ` +
        '(a dependency of the kozou CLI). This usually means a broken install — ' +
        'reinstall kozou, or in a workspace checkout build it with ' +
        '`pnpm --filter @kozou/api run build`. Alternatively select a different ' +
        'adapter kind via --adapter or the `adapter.type` config field.',
    );
  }

  const { introspect } = await import('@kozou/introspect');
  const { buildSchemaContext } = await import('@kozou/core');
  const { default: pg } = await import('pg');

  const raw = await introspect({
    connection: config.database.url,
    schemas: config.database.schemas,
  });
  const schema = await buildSchemaContext({ raw });
  const pool = new pg.Pool({ connectionString: config.database.url });
  const server = await apiModule.startApiServer({
    schema,
    db: { query: (text: string, values?: unknown[]) => pool.query(text, values) },
    // When `auth` is configured the API verifies a JWT and runs each request
    // under SET LOCAL ROLE, which needs a dedicated client per request — pass
    // the pool. With no `auth`, the pool is unused and the API stays
    // unauthenticated (loopback-only), exactly as before.
    pool,
    auth: config.auth,
    host: API_HOST,
    port,
    // Advertise the kozou CLI version in the API's `GET /` and OpenAPI
    // `info.version`; without this it falls back to the package default.
    version: PACKAGE_VERSION,
    logPrefix: `${PREFIX} api`,
  });

  return {
    url: `http://${API_HOST}:${server.port}`,
    close: async () => {
      await server.close();
      await pool.end();
    },
  };
}

function warnIfPublic(label: string, host: string): void {
  if (isLoopbackHost(host)) return;
  process.stderr.write(
    `${PREFIX} WARNING: ${label} bound to non-loopback host "${host}".\n` +
      `${PREFIX} v0.1 has NO authentication (spec §18.5). Anyone who can reach\n` +
      `${PREFIX} ${host} can use it. This is expected inside docker compose;\n` +
      `${PREFIX} avoid it on an untrusted network or put an auth proxy in front.\n`,
  );
}

export async function devCommand(opts: DevOptions = {}): Promise<void> {
  if (opts.adapter !== undefined && !(ADAPTER_KINDS as readonly string[]).includes(opts.adapter)) {
    throw new Error(
      `${PREFIX} unknown --adapter "${opts.adapter}" (valid kinds: ${ADAPTER_KINDS.join(', ')}).`,
    );
  }

  const config = await loadConfig({ path: opts.config });

  // The Admin UI runs against the in-house @kozou/api backend by default; an
  // explicit --adapter overrides the config's `adapter.type`. Any kind other
  // than `api` is the external REST opt-out (the UI talks to it over HTTP).
  const adapterKind: AdapterKind = (opts.adapter as AdapterKind | undefined) ?? config.adapter.type;
  const useInhouseApi = adapterKind === 'api';

  const adminUiEntry = resolveAdminUiEntry();
  if (!existsSync(adminUiEntry)) {
    throw new Error(
      `${PREFIX} Admin UI build not found at ${adminUiEntry}. ` +
        'Reinstall @kozou/svelte-ui (its `build/` output ships in the package), ' +
        'or in a workspace checkout run `pnpm --filter @kozou/svelte-ui run build`.',
    );
  }

  // In-house @kozou/api backend (the default), started before the other
  // servers so its URL can be wired into the UI environment. Skipped for the
  // external REST opt-out.
  const api: InhouseApi | null = useInhouseApi
    ? await startInhouseApi(config, opts.apiPort ?? DEFAULT_API_PORT)
    : null;
  if (api) {
    process.stderr.write(`${PREFIX} in-house @kozou/api on ${api.url}\n`);
  }

  // When the in-house API enforces auth, resolve the token the bundled Admin
  // UI presents to it: a minted HS256 token, a supplied RS256 / external one,
  // or none (with a warning) when neither is available. @kozou/api is already
  // imported (startInhouseApi succeeded), so this dynamic import is cached.
  let apiToken: string | undefined;
  if (api && config.auth) {
    const apiModule = await import('@kozou/api');
    const resolved = await resolveAdminUiToken(config, apiModule, process.env);
    if (resolved.warning) {
      process.stderr.write(`${PREFIX} WARNING: ${resolved.warning}\n`);
    }
    apiToken = resolved.token;
  }

  const cache = new SchemaCache({
    connection: config.database.url,
    schemas: config.database.schemas,
    ttlMs: config.cache.ttlMs,
  });

  // 1. MCP HTTP, in-process. startHttpServer already warns on a
  //    non-loopback bind, so we do not double-warn for it.
  const mcp = await startHttpServer(cache, {
    port: config.server.mcp.http.port,
    host: config.server.mcp.http.host,
    logPrefix: `${PREFIX} mcp`,
  });

  // 2. Admin UI, as a child process.
  warnIfPublic('Admin UI', config.server.ui.host);
  const origin = resolveOrigin(config, process.env);
  const child = spawn('node', [adminUiEntry], {
    env: buildAdminUiEnv(config, origin, process.env, api?.url, apiToken),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (b: Buffer) => process.stdout.write(`${PREFIX} ui | ${b}`));
  child.stderr?.on('data', (b: Buffer) => process.stderr.write(`${PREFIX} ui | ${b}`));

  process.stderr.write(
    `${PREFIX} Admin UI on http://${config.server.ui.host}:${config.server.ui.port}` +
      ` (origin ${origin})\n`,
  );

  // 3. Lifecycle: tear everything down together. Resolve the promise (and
  //    thus let the CLI exit) only once everything has stopped.
  const closeBackends = (): Promise<unknown> =>
    Promise.allSettled([mcp.close(), api ? api.close() : Promise.resolve()]);

  await new Promise<void>((resolve) => {
    let shuttingDown = false;

    const shutdown = (reason: string): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      process.stderr.write(`${PREFIX} ${reason}, shutting down\n`);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
      }
      void closeBackends().finally(() => resolve());
    };

    process.on('SIGINT', () => shutdown('SIGINT received'));
    process.on('SIGTERM', () => shutdown('SIGTERM received'));

    child.on('exit', (code, signal) => {
      if (shuttingDown) return;
      // The Admin UI process died on its own — surface its exit status
      // and bring the MCP server down with it.
      process.stderr.write(
        `${PREFIX} Admin UI exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})\n`,
      );
      process.exitCode = code ?? 1;
      shuttingDown = true;
      void closeBackends().finally(() => resolve());
    });

    child.on('error', (err) => {
      process.stderr.write(`${PREFIX} failed to spawn Admin UI: ${err.message}\n`);
      process.exitCode = 1;
      shutdown('spawn error');
    });
  });
}
