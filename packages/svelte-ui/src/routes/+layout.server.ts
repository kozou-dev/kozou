// Layout-level server load. Surfaces top-level navigation counts
// without flushing the entire SchemaContext to the client (it can
// be megabytes once a database has a hundred-plus tables).
// See Kozou v0.1 design spec §8.5.

import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ locals }) => {
  return {
    appName: 'Kozou',
    tableCount: locals.schema.tables.length,
    viewCount: locals.schema.views.length,
  };
};
