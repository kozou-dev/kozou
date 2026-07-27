// Shared lifecycle state for the `kozou dev` Playwright E2E suite.
//
// Playwright loads `globalSetup` and `globalTeardown` in the same Node
// runtime, so importing this module from both files yields the same
// singleton instance. Each step in `globalSetup` writes its handle here;
// `globalTeardown` reads them back to stop everything in reverse order.

import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedNetwork, StartedTestContainer } from 'testcontainers';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';

/** What `spawn(..., { stdio: ['ignore', 'pipe', 'pipe'] })` actually returns:
 *  no stdin, both output streams piped. `ChildProcessWithoutNullStreams` —
 *  the previous annotation — promises a writable stdin these processes do
 *  not have, which is why assigning to it never typechecked. */
type DevProcess = ChildProcessByStdio<null, Readable, Readable>;

export interface E2EState {
  network?: StartedNetwork;
  postgres?: StartedPostgreSqlContainer;
  // The REST-adapter sidecar container (a SQL-to-REST gateway image).
  adapter?: StartedTestContainer;
  // The `kozou dev` process under test (Admin UI child + in-process MCP).
  kozouDev?: DevProcess;
  // Temp dir holding the generated kozou.config.yaml.
  configDir?: string;
  // A second `kozou dev` against the same backend with
  // `server.mcp.http.enabled: false` — the opted-out runtime, which has no
  // MCP listener and whose Admin UI drops the "Connect an AI agent" page.
  kozouDevMcpOff?: DevProcess;
  configDirMcpOff?: string;
}

export const state: E2EState = {};
