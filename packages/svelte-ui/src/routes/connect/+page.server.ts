// "Connect an AI agent" route. Surfaces the live MCP Streamable HTTP endpoint
// and copy-paste client config so an operator (often a non-engineer) can point
// Claude / Cursor at this database from the surface they already use — the
// Admin UI — instead of finding the connection docs unaided. Pure projection
// lives in $lib/connect/mcp-connection so the template stays declarative.

import type { PageServerLoad } from './$types';

import {
  buildMcpConnectionInfo,
  resolveMcpHttpPort,
} from '$lib/connect/mcp-connection.js';

export const load: PageServerLoad = ({ url }) => {
  // `kozou dev` forwards the co-located MCP HTTP server's port; absent (e.g. the
  // UI run standalone) falls back to the documented default. The host comes from
  // the UI's request URL — ORIGIN-bound under `kozou dev`, so `localhost` by
  // default; the page tells the operator to adjust it for a proxy/remote host.
  const mcpPort = resolveMcpHttpPort(process.env.KOZOU_MCP_HTTP_PORT);
  return {
    connection: buildMcpConnectionInfo({ requestUrl: url, mcpPort }),
  };
};
