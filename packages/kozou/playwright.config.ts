// Playwright config for the `kozou dev` full-stack E2E suite.
//
// The suite spins up postgres + the REST adapter via testcontainers and
// launches `node dist/cli.js dev` against them (see e2e/setup/global-
// setup.ts), then drives the Admin UI through a real browser and the MCP
// HTTP server through the MCP SDK client. This complements the
// @kozou/svelte-ui suite, which spawns the Admin UI server directly: here
// the dev command's own config -> env / ORIGIN / both-servers wiring is
// what's under test.

import { defineConfig } from '@playwright/test';

// Fixed ports the generated kozou.config.yaml binds to (127.0.0.1). 3433
// / 3434 sit one above the `kozou dev` defaults (3333 / 3334) so a local
// dev instance on the defaults does not collide with the suite.
const UI_PORT = 3433;

export default defineConfig({
  testDir: './e2e/specs',

  // One backend (postgres + REST adapter) plus one `kozou dev` process is
  // shared across the suite, so concurrent writes would race. Keep it
  // simple with workers=1, matching the svelte-ui suite.
  fullyParallel: false,
  workers: 1,

  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never' }]]
    : 'list',

  globalSetup: './e2e/setup/global-setup.ts',
  globalTeardown: './e2e/setup/global-teardown.ts',

  use: {
    baseURL: `http://127.0.0.1:${UI_PORT}`,
    trace: 'on-first-retry',
  },

  retries: process.env.CI ? 1 : 0,

  // The container + `kozou dev` boot cost is paid once in globalSetup, so
  // individual specs stay fast; the MCP session round-trip is well within.
  timeout: 60_000,
});
