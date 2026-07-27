// Shared lifecycle state for the `kozou dev --adapter api` E2E suite.
//
// Simpler than the default-adapter suite: no docker network and no
// data-backend sidecar — `kozou dev --adapter api` starts the in-house
// @kozou/api server itself, in-process, against the postgres container.

import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';

/** What `spawn(..., { stdio: ['ignore', 'pipe', 'pipe'] })` actually returns:
 *  no stdin, both output streams piped. `ChildProcessWithoutNullStreams` —
 *  the previous annotation — promises a writable stdin these processes do
 *  not have, which is why assigning to it never typechecked. */
type DevProcess = ChildProcessByStdio<null, Readable, Readable>;

export interface E2EApiState {
  postgres?: StartedPostgreSqlContainer;
  kozouDev?: DevProcess;
  configDir?: string;
}

export const state: E2EApiState = {};
