// `kozou dev` command implementation.
//
// Brings up the full local runtime:
//   - the bundled @kozou/svelte-ui Admin UI, spawned as a child process
//     (`node <svelte-ui>/build/index.js` — the adapter-node standalone
//     server, the same entry the svelte-ui E2E suite exercises);
//   - the MCP Streamable HTTP server, run in-process via @kozou/mcp's
//     startHttpServer, unless server.mcp.http.enabled is false (then the
//     Admin UI and REST come up alone and no MCP listener exists).
//
// Both bind loopback (127.0.0.1) by default because the UI and MCP listeners
// have no authentication of their own; a container opts into 0.0.0.0 via
// KOZOU_UI_HOST / KOZOU_MCP_HTTP_HOST (the compose template sets these and
// publishes the host ports on loopback). A loud warning fires on a non-loopback
// bind (the in-house API may enforce JWT auth; the Admin UI warning
// distinguishes that case).
//
// The Admin UI is an adapter-node (SvelteKit) server: without ORIGIN it
// assumes https and rejects every form POST over plain http with a 403.
// We default ORIGIN to http://localhost:<ui-port>; override via the
// ORIGIN / KOZOU_ORIGIN env when serving on a different public URL.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

import { SchemaCache, startHttpServer, isLoopbackHost, type HttpServerHandle } from '@kozou/mcp';

import {
  loadConfig,
  resolveMcpAuthOptions,
  type KozouConfig,
  ADAPTER_KINDS,
  type AdapterKind,
  resolveMcpGuardOptions,
} from '../config.js';
import { PACKAGE_VERSION } from '../version.js';
import {
  buildAdminUiEnv,
  classifyAdminUiExposure,
  describeApiAuth,
  resolveAdminUiEntry,
  resolveAdminUiToken,
  resolveDevPrivilegeRole,
  resolveOrigin,
  type AdminUiExposure,
  type AdminUiTokenResult,
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

// The in-house @kozou/api server exists for the Admin UI's server-side
// fetch, so it binds loopback: the port is configurable (--api-port), the
// host is not. That constrains where a caller is, not who it is — anything
// sharing that loopback reaches it (other processes on this host when run
// directly, other processes in the container under compose; examples/react
// and the e2e suite both do), with no authentication until `auth` is
// configured. What is published is a deployment question this file cannot
// see, so it says nothing about it.
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
  // Pass the RPC exposure config (issue #103) so `@expose: rpc` functions —
  // and the SECURITY DEFINER / public-callable ones the operator opts in to —
  // are compiled into the API's `/rpc/` surface.
  const schema = await buildSchemaContext({ raw, rpc: config.api.rpc });
  const pool = new pg.Pool({ connectionString: config.database.url });
  const server = await apiModule.startApiServer({
    schema,
    db: { query: (text: string, values?: unknown[]) => pool.query(text, values) },
    // When `auth` is configured the API verifies a JWT and runs each request
    // under SET LOCAL ROLE, which needs a dedicated client per request — pass
    // the pool. With no `auth`, the pool is unused and the API stays
    // unauthenticated, exactly as before.
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

// Warn when a surface with no authentication of its own binds beyond
// loopback. The Admin UI never has a login of its own; what varies is how
// the API behind it treats the UI's requests, so the warning states the
// resolved exposure mode instead of implying nothing (or everything) is
// protected.
function warnIfPublic(label: string, host: string, exposure: AdminUiExposure): void {
  if (isLoopbackHost(host)) return;
  const detail: Record<AdminUiExposure, string> = {
    unauthenticated: `${PREFIX} It has NO authentication. Anyone who can reach ${host} can use it.\n`,
    'service-token':
      `${PREFIX} The API behind it verifies JWTs, but ${label} itself has no login —\n` +
      `${PREFIX} anyone who can reach ${host} acts with its service token.\n`,
    'anon-role':
      `${PREFIX} The API behind it verifies JWTs and ${label} holds no token, so\n` +
      `${PREFIX} anyone who can reach ${host} acts as the anonymous role.\n`,
    rejected:
      `${PREFIX} The API behind it verifies JWTs and ${label} holds no usable token,\n` +
      `${PREFIX} so the API rejects its requests; the port itself stays reachable.\n`,
  };
  process.stderr.write(
    `${PREFIX} WARNING: ${label} bound to non-loopback host "${host}".\n` +
      detail[exposure] +
      `${PREFIX} This is expected inside docker compose; avoid it on an untrusted\n` +
      `${PREFIX} network or put an auth proxy in front.\n`,
  );
}

// Build the schema cache and start the in-process MCP HTTP server.
// startHttpServer already warns on a non-loopback bind, so we do not
// double-warn for it. A configured server.mcp.http.auth block is honoured here
// too — the config declaring OAuth and `kozou dev` serving the endpoint open
// would be a silent posture downgrade.
export async function startDevMcp(config: KozouConfig, apiActive: boolean): Promise<HttpServerHandle> {
  // Privilege-aware annotation (issue #99) for the in-process MCP server, using
  // the same resolved role the Admin UI child runs as, so describe_table /
  // describe_view tell an agent what that role may touch. Off => schema-wide.
  const privilegeRole = resolveDevPrivilegeRole(config, { apiActive, env: process.env });

  const cache = new SchemaCache({
    connection: config.database.url,
    schemas: config.database.schemas,
    ttlMs: config.cache.ttlMs,
    // Same RPC exposure config as the API, so describe_functions advertises
    // the same exposed set the /rpc/ surface serves (issue #103).
    rpc: config.api.rpc,
    ...(privilegeRole === undefined ? {} : { privilegeRole }),
  });
  if (privilegeRole !== undefined) {
    process.stderr.write(
      `${PREFIX} mcp privilege-aware context ON: describe tools annotate what role ` +
        `"${privilegeRole}" may touch (advisory; enforcement stays in PostgreSQL)\n`,
    );
  }

  const auth = resolveMcpAuthOptions(config);
  const http = config.server.mcp.http;
  return startHttpServer(cache, {
    port: http.port,
    host: http.host,
    logPrefix: `${PREFIX} mcp`,
    provenance: config.server.mcp.provenance,
    // The declared reachable address and any extra Host names belong to the
    // rebinding guard, not just to the /connect page: a tunnel or proxy that
    // does not rewrite the Host header forwards the public hostname, and
    // without this every request from it is refused.
    ...resolveMcpGuardOptions(config),
    ...(auth === undefined ? {} : { auth }),
  });
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
    // State the auth mode unambiguously: a stack whose KOZOU_JWT_* env never
    // reached this process fails open, and this line is what surfaces it.
    process.stderr.write(`${PREFIX} api auth: ${describeApiAuth(config.auth)}\n`);
  }

  // When the in-house API enforces auth, resolve the token the bundled Admin
  // UI presents to it: a minted HS256 token, a supplied RS256 / external one,
  // or none (with a warning) when neither is available. @kozou/api is already
  // imported (startInhouseApi succeeded), so this dynamic import is cached.
  let tokenResult: AdminUiTokenResult | undefined;
  if (api && config.auth) {
    const apiModule = await import('@kozou/api');
    tokenResult = await resolveAdminUiToken(config, apiModule, process.env);
    if (tokenResult.warning) {
      process.stderr.write(`${PREFIX} WARNING: ${tokenResult.warning}\n`);
    }
  }
  const apiToken = tokenResult?.token;

  // 1. MCP HTTP, in-process — unless the config opts out. With
  //    server.mcp.http.enabled false no listener is started and no schema
  //    cache is built (the cache exists only to serve MCP here), so the
  //    endpoint is absent rather than merely bound somewhere unreachable.
  //    The Admin UI and REST below are unaffected.
  const mcp = config.server.mcp.http.enabled ? await startDevMcp(config, api?.url !== undefined) : null;
  if (mcp === null) {
    // Name what is still up, not a fixed list: on the external-REST opt-out
    // kozou serves no REST of its own, so claiming it would be exactly as
    // wrong as "Admin UI only" is on the default path. Name both config routes
    // too — the value may have come from the environment, and pointing at a
    // YAML key the operator never wrote is the confusion this control exists
    // to avoid.
    process.stderr.write(
      `${PREFIX} mcp HTTP endpoint disabled (server.mcp.http.enabled / ` +
        `KOZOU_MCP_HTTP_ENABLED); serving the Admin UI${api ? ' and REST' : ''} only\n`,
    );
  }

  // 2. Admin UI, as a child process.
  warnIfPublic(
    'Admin UI',
    config.server.ui.host,
    classifyAdminUiExposure(config.auth, tokenResult, api !== null),
  );
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
    Promise.allSettled([mcp ? mcp.close() : Promise.resolve(), api ? api.close() : Promise.resolve()]);

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
