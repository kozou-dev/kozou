// Shared lifecycle state for the `kozou dev --adapter api` E2E suite.
//
// Simpler than the default-adapter suite: no docker network and no
// data-backend sidecar — `kozou dev --adapter api` starts the in-house
// @kozou/api server itself, in-process, against the postgres container.

import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

export interface E2EApiState {
  postgres?: StartedPostgreSqlContainer;
  kozouDev?: ChildProcessWithoutNullStreams;
  configDir?: string;
}

export const state: E2EApiState = {};
