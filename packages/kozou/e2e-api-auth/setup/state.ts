// Shared lifecycle state for the `kozou dev --adapter api` auth E2E suite.
//
// Same shape as the no-auth api suite: a postgres container and the spawned
// `kozou dev` process (which starts the in-house @kozou/api with JWT auth and
// the bundled Admin UI), plus the temp config directory.

import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';

/** What `spawn(..., { stdio: ['ignore', 'pipe', 'pipe'] })` actually returns:
 *  no stdin, both output streams piped. `ChildProcessWithoutNullStreams` —
 *  the previous annotation — promises a writable stdin these processes do
 *  not have, which is why assigning to it never typechecked. */
type DevProcess = ChildProcessByStdio<null, Readable, Readable>;

export interface E2EApiAuthState {
  postgres?: StartedPostgreSqlContainer;
  kozouDev?: DevProcess;
  configDir?: string;
}

export const state: E2EApiAuthState = {};
