// Playwright globalTeardown: stop everything globalSetup brought up.
//
// Each shutdown is wrapped in a guarded promise so that a failure in one
// step does not block the rest - leaving stray containers around would
// quickly exhaust local Docker resources in dev loops.

import { state } from './state.js';

async function safe(label: string, action: () => Promise<unknown> | unknown) {
  try {
    await action();
  } catch (err) {
    console.warn(`[e2e teardown] failed to stop ${label}:`, err);
  }
}

export default async function globalTeardown() {
  console.log('[e2e teardown] stopping services');

  if (state.svelteUi && !state.svelteUi.killed) {
    state.svelteUi.kill('SIGTERM');
  }
  await safe('postgrest', () => state.postgrest?.stop());
  await safe('postgres', () => state.postgres?.stop());
  await safe('network', () => state.network?.stop());

  console.log('[e2e teardown] done');
}
