// Playwright globalTeardown for the @kozou/api seam-swap suite. Stops
// everything globalSetup brought up, in reverse order, each guarded so a
// single failure does not strand the rest.

import { state } from './state.js';

async function safe(label: string, action: () => Promise<unknown> | unknown) {
  try {
    await action();
  } catch (err) {
    console.warn(`[e2e-api teardown] failed to stop ${label}:`, err);
  }
}

export default async function globalTeardown() {
  console.log('[e2e-api teardown] stopping services');

  if (state.svelteUi && !state.svelteUi.killed) {
    state.svelteUi.kill('SIGTERM');
  }
  await safe('api', () => state.api?.close());
  await safe('pool', () => state.pool?.end());
  await safe('postgres', () => state.postgres?.stop());

  console.log('[e2e-api teardown] done');
}
