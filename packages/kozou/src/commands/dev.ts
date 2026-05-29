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

import { loadConfig } from '../config.js';
import {
  buildAdminUiEnv,
  resolveAdminUiEntry,
  resolveOrigin,
} from './dev-runtime.js';

export type DevOptions = {
  config?: string;
};

const PREFIX = '[kozou dev]';

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
  const config = await loadConfig({ path: opts.config });

  const adminUiEntry = resolveAdminUiEntry();
  if (!existsSync(adminUiEntry)) {
    throw new Error(
      `${PREFIX} Admin UI build not found at ${adminUiEntry}. ` +
        'Reinstall @kozou/svelte-ui (its `build/` output ships in the package), ' +
        'or in a workspace checkout run `pnpm --filter @kozou/svelte-ui run build`.',
    );
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
    env: buildAdminUiEnv(config, origin, process.env),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (b: Buffer) => process.stdout.write(`${PREFIX} ui | ${b}`));
  child.stderr?.on('data', (b: Buffer) => process.stderr.write(`${PREFIX} ui | ${b}`));

  process.stderr.write(
    `${PREFIX} Admin UI on http://${config.server.ui.host}:${config.server.ui.port}` +
      ` (origin ${origin})\n`,
  );

  // 3. Lifecycle: tear both down together. Resolve the promise (and thus
  //    let the CLI exit) only once everything has stopped.
  await new Promise<void>((resolve) => {
    let shuttingDown = false;

    const shutdown = (reason: string): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      process.stderr.write(`${PREFIX} ${reason}, shutting down\n`);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
      }
      void mcp.close().finally(() => resolve());
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
      void mcp.close().finally(() => resolve());
    });

    child.on('error', (err) => {
      process.stderr.write(`${PREFIX} failed to spawn Admin UI: ${err.message}\n`);
      process.exitCode = 1;
      shutdown('spawn error');
    });
  });
}
