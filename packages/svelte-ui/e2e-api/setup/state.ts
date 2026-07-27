// Shared lifecycle state for the @kozou/api seam-swap E2E suite.
//
// Mirrors e2e/setup/state.ts but the backend is the in-house @kozou/api
// server started in-process (no external backend container). globalSetup writes
// each handle here; globalTeardown reads them back to tear everything
// down in reverse order.

import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { Pool } from 'pg';
import type { ApiServerHandle } from '@kozou/api';

/** What `spawn(..., { stdio: ['ignore', 'pipe', 'pipe'] })` actually returns:
 *  no stdin, both output streams piped. `ChildProcessWithoutNullStreams` —
 *  the previous annotation — promises a writable stdin these processes do
 *  not have, which is why assigning to it never typechecked. */
type DevProcess = ChildProcessByStdio<null, Readable, Readable>;

export interface E2EApiState {
  postgres?: StartedPostgreSqlContainer;
  pool?: Pool;
  api?: ApiServerHandle;
  svelteUi?: DevProcess;
}

export const state: E2EApiState = {};
