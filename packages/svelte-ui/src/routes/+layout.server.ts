// Layout-level server load. Surfaces top-level navigation counts
// without flushing the entire SchemaContext to the client (it can
// be megabytes once a database has a hundred-plus tables).

import type { LayoutServerLoad } from './$types';

import { resolveMcpPosture } from '$lib/connect/mcp-connection.js';

export const load: LayoutServerLoad = ({ locals }) => {
  return {
    appName: 'Kozou',
    tableCount: locals.schema.tables.length,
    viewCount: locals.schema.views.length,
    // Whether an MCP endpoint exists to point an agent at. Resolved here, at
    // the layout, because both entry points to the connection page (the header
    // link and the dashboard card) need it — offering either one while
    // `kozou dev` runs with server.mcp.http.enabled false would send the
    // operator to a page describing an endpoint that is not listening.
    mcpEnabled: resolveMcpPosture(process.env.KOZOU_UI_MCP_POSTURE) !== 'off',
  };
};
