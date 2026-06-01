// Playwright globalTeardown for the `kozou dev --adapter api` auth suite.
// Stops the kozou dev process (which brings down its child Admin UI +
// in-process @kozou/api) and the postgres container.

import { state } from './state.js';

async function safe(label: string, action: () => Promise<unknown> | unknown) {
  try {
    await action();
  } catch (err) {
    console.warn(`[kozou-e2e-api-auth teardown] failed to stop ${label}:`, err);
  }
}

export default async function globalTeardown() {
  console.log('[kozou-e2e-api-auth teardown] stopping services');

  if (state.kozouDev && !state.kozouDev.killed) {
    state.kozouDev.kill('SIGTERM');
  }
  await safe('postgres', () => state.postgres?.stop());

  console.log('[kozou-e2e-api-auth teardown] done');
}
