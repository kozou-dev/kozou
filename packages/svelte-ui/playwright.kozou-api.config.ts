// Playwright config for the @kozou/api seam-swap E2E suite (Kozou v0.2
// Phase 4b). Identical Admin UI to the sibling e2e/ suite — only the
// backend differs: globalSetup starts the in-house @kozou/api server and
// spawns svelte-ui with KOZOU_ADAPTER_KIND=api. Proving the same UI build
// passes a CRUD loop here is the Kozou v0.2 DoD.
//
// Kept as a separate config (distinct testDir + report folders) so it can
// run as its own CI job alongside the sibling e2e/ suite without
// clobbering its artifacts.

import { defineConfig } from '@playwright/test';

const SVELTE_UI_PORT = 4174;

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
    baseURL: `http://127.0.0.1:${SVELTE_UI_PORT}`,
    trace: 'on-first-retry',
  },

  retries: process.env.CI ? 1 : 0,
  timeout: 30_000,
});
