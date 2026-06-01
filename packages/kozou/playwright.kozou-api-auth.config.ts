// Playwright config for the `kozou dev --adapter api` auth E2E suite. Launches
// `node dist/cli.js dev --adapter api` with an `auth:` block (see
// e2e-api-auth/setup/global-setup.ts), which mints an HS256 token for the
// bundled Admin UI and serves it RLS-filtered rows. Kept separate from the
// no-auth api config (distinct testDir + report folders) so it runs as its
// own CI job.

import { defineConfig } from '@playwright/test';

const UI_PORT = 3445;

export default defineConfig({
  testDir: './e2e-api-auth/specs',
  outputDir: './test-results-api-auth',

  fullyParallel: false,
  workers: 1,

  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never', outputFolder: 'playwright-report-api-auth' }]]
    : 'list',

  globalSetup: './e2e-api-auth/setup/global-setup.ts',
  globalTeardown: './e2e-api-auth/setup/global-teardown.ts',

  use: {
    baseURL: `http://127.0.0.1:${UI_PORT}`,
    trace: 'on-first-retry',
  },

  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
});
