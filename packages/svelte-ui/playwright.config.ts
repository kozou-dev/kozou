// Playwright config for @kozou/svelte-ui end-to-end tests.
// Tracks Playwright E2E / Step 6-M.
//
// The suite spins up postgres + postgrest + svelte-ui via testcontainers
// (see e2e/setup/global-setup.ts) and exercises the Admin UI through a
// real browser. v0.1.1 ships a smoke set (dashboard / list / view);
// follow-up PRs extend it across the full CRUD loop.

import { defineConfig } from '@playwright/test';

// Fixed port so the spawned svelte-ui handler and Playwright share an
// agreed URL. Each CI invocation gets a fresh runner so the port collision
// risk is bounded.
const SVELTE_UI_PORT = 4173;

export default defineConfig({
  testDir: './e2e/specs',

  // One backend (postgres + postgrest + svelte-ui) is shared across the
  // suite, so concurrent writes would race. v0.1.1 keeps things simple
  // with workers=1; a future PR can either give each spec its own DB
  // schema or stand up a dedicated stack per worker.
  fullyParallel: false,
  workers: 1,

  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never' }]]
    : 'list',

  globalSetup: './e2e/setup/global-setup.ts',
  globalTeardown: './e2e/setup/global-teardown.ts',

  use: {
    baseURL: `http://127.0.0.1:${SVELTE_UI_PORT}`,
    trace: 'on-first-retry',
  },

  retries: process.env.CI ? 1 : 0,

  // Per-spec budget. The boot cost (containers + svelte-ui build) is paid
  // once in globalSetup so individual specs stay fast.
  timeout: 30_000,
});
