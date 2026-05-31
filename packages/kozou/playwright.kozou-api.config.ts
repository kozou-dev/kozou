// Playwright config for the `kozou dev --adapter api` E2E suite (Kozou
// v0.2 CLI integration). Launches `node dist/cli.js dev --adapter api`
// (see e2e-api/setup/global-setup.ts), which starts the in-house
// @kozou/api server in-process and spawns the Admin UI pointed at it,
// then drives a full browser CRUD loop. Kept separate from the default-
// adapter config (distinct testDir + report folders) so it runs as its
// own CI job.

import { defineConfig } from '@playwright/test';

const UI_PORT = 3435;

export default defineConfig({
  testDir: './e2e-api/specs',
  outputDir: './test-results-api',

  fullyParallel: false,
  workers: 1,

  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never', outputFolder: 'playwright-report-api' }]]
    : 'list',

  globalSetup: './e2e-api/setup/global-setup.ts',
  globalTeardown: './e2e-api/setup/global-teardown.ts',

  use: {
    baseURL: `http://127.0.0.1:${UI_PORT}`,
    trace: 'on-first-retry',
  },

  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
});
