// Dashboard route data loader. Pure projection lives in
// $lib/dashboard/group so the .svelte template stays declarative
// and the projection is unit-testable in isolation.

import type { PageServerLoad } from './$types';

import { groupForDashboard } from '$lib/dashboard/group.js';
import { getAdapter } from '$lib/server/adapter.js';

export const load: PageServerLoad = ({ locals }) => {
  // The "Actions" surface only works against a backend that serves /rpc/ (the
  // in-house @kozou/api adapter implements callFunction; the external REST
  // opt-out adapter does not). Gate the surface on that capability so it never
  // advertises functions it cannot invoke.
  const actionsEnabled = typeof getAdapter(locals.schema).callFunction === 'function';
  return {
    dashboard: groupForDashboard(locals.schema),
    actionsEnabled,
  };
};
