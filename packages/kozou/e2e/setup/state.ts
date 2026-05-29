// Shared lifecycle state for the `kozou dev` Playwright E2E suite.
//
// Playwright loads `globalSetup` and `globalTeardown` in the same Node
// runtime, so importing this module from both files yields the same
// singleton instance. Each step in `globalSetup` writes its handle here;
// `globalTeardown` reads them back to stop everything in reverse order.

import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedNetwork, StartedTestContainer } from 'testcontainers';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

export interface E2EState {
  network?: StartedNetwork;
  postgres?: StartedPostgreSqlContainer;
  // The REST-adapter sidecar container (a SQL-to-REST gateway image).
  adapter?: StartedTestContainer;
  // The `kozou dev` process under test (Admin UI child + in-process MCP).
  kozouDev?: ChildProcessWithoutNullStreams;
  // Temp dir holding the generated kozou.config.yaml.
  configDir?: string;
}

export const state: E2EState = {};
