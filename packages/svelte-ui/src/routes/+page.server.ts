// Dashboard route data loader. Pure projection lives in
// $lib/dashboard/group so the .svelte template stays declarative
// and the projection is unit-testable in isolation.
// See Kozou v0.1 design spec §8.3.1.

import type { PageServerLoad } from './$types';

import { groupForDashboard } from '$lib/dashboard/group.js';

export const load: PageServerLoad = ({ locals }) => {
  return {
    dashboard: groupForDashboard(locals.schema),
  };
};
