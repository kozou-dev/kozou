// Shared lifecycle state for the @kozou/api seam-swap E2E suite.
//
// Mirrors e2e/setup/state.ts but the backend is the in-house @kozou/api
// server started in-process (no PostgREST container). globalSetup writes
// each handle here; globalTeardown reads them back to tear everything
// down in reverse order.

import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Pool } from 'pg';
import type { ApiServerHandle } from '@kozou/api';

export interface E2EApiState {
  postgres?: StartedPostgreSqlContainer;
  pool?: Pool;
  api?: ApiServerHandle;
  svelteUi?: ChildProcessWithoutNullStreams;
}

export const state: E2EApiState = {};
