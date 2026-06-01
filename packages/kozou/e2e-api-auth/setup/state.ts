// Shared lifecycle state for the `kozou dev --adapter api` auth E2E suite.
//
// Same shape as the no-auth api suite: a postgres container and the spawned
// `kozou dev` process (which starts the in-house @kozou/api with JWT auth and
// the bundled Admin UI), plus the temp config directory.

import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

export interface E2EApiAuthState {
  postgres?: StartedPostgreSqlContainer;
  kozouDev?: ChildProcessWithoutNullStreams;
  configDir?: string;
}

export const state: E2EApiAuthState = {};
