// Playwright globalTeardown: stop everything globalSetup brought up.
//
// The `kozou dev` process is asked to shut down with SIGTERM first — its
// own handler tears down the in-process MCP server and SIGTERMs the Admin
// UI child — and we wait (bounded) for it to exit. That doubles as a
// graceful-shutdown check: a clean exit within the timeout proves the
// signal handling works; otherwise we SIGKILL and warn. Container stops
// are each wrapped in a guard so one failure does not strand the rest.

import { rmSync } from 'node:fs';

import { state } from './state.js';

async function safe(label: string, action: () => Promise<unknown> | unknown) {
  try {
    await action();
  } catch (err) {
    console.warn(`[kozou-e2e teardown] failed to stop ${label}:`, err);
  }
}

// Send SIGTERM to `kozou dev` and resolve once it exits, or after
// timeoutMs (SIGKILL fallback). Resolves immediately if it already exited.
function stopKozouDev(
  child: typeof state.kozouDev,
  label: string,
  timeoutMs: number,
): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      console.warn(
        `[kozou-e2e teardown] ${label} did not exit within ${timeoutMs}ms; sending SIGKILL`,
      );
      child.kill('SIGKILL');
      resolve();
    }, timeoutMs);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      console.log(
        `[kozou-e2e teardown] ${label} exited gracefully ` +
          `(code=${code ?? 'null'}, signal=${signal ?? 'null'})`,
      );
      resolve();
    });
    child.kill('SIGTERM');
  });
}

export default async function globalTeardown() {
  console.log('[kozou-e2e teardown] stopping services');

  await safe('kozou dev', () => stopKozouDev(state.kozouDev, 'kozou dev', 10_000));
  await safe('kozou dev (mcp off)', () =>
    stopKozouDev(state.kozouDevMcpOff, 'kozou dev (mcp off)', 10_000),
  );
  // The generated configs live in mkdtemp directories; without this each run
  // leaves one behind in $TMPDIR, and `state.configDir*` would be written and
  // never read.
  await safe('temp config dirs', () => {
    for (const dir of [state.configDir, state.configDirMcpOff]) {
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    }
  });
  await safe('adapter', () => state.adapter?.stop());
  await safe('postgres', () => state.postgres?.stop());
  await safe('network', () => state.network?.stop());

  console.log('[kozou-e2e teardown] done');
}
