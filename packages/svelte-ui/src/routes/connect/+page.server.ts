// "Connect an AI agent" route. Surfaces the live MCP Streamable HTTP endpoint
// and copy-paste client config so an operator (often a non-engineer) can point
// Claude / Cursor at this database from the surface they already use — the
// Admin UI — instead of finding the connection docs unaided. Pure projection
// lives in $lib/connect/mcp-connection so the template stays declarative.

import { error } from '@sveltejs/kit';

import type { PageServerLoad } from './$types';

import {
  buildMcpConnectionInfo,
  resolveMcpHttpPort,
  resolveMcpPosture,
} from '$lib/connect/mcp-connection.js';

export const load: PageServerLoad = ({ url }) => {
  // `kozou dev` reports which posture the endpoint runs in; the page has to
  // describe the one it is actually in, because "no authentication" is false of
  // an OAuth-protected resource and it is the sentence an operator would use to
  // decide whether the port is safe to expose.
  const posture = resolveMcpPosture(process.env.KOZOU_UI_MCP_POSTURE);
  // Hiding the two links is not enough: this URL is reachable directly, from a
  // bookmark or a shared link. Serving the page with no endpoint behind it
  // would hand the operator copy-paste config for a listener that is not
  // running, which is a worse failure than the page being absent.
  if (posture === 'off') {
    error(
      404,
      'The MCP HTTP endpoint is turned off for this runtime (server.mcp.http.enabled: false), so there is nothing to connect an agent to.',
    );
  }
  // `kozou dev` forwards the co-located MCP HTTP server's port; absent (e.g. the
  // UI run standalone) falls back to the documented default. The host comes from
  // the UI's request URL — ORIGIN-bound under `kozou dev`, so `localhost` by
  // default; the page tells the operator to adjust it for a proxy/remote host.
  const mcpPort = resolveMcpHttpPort(process.env.KOZOU_MCP_HTTP_PORT);
  return {
    connection: buildMcpConnectionInfo({
      requestUrl: url,
      mcpPort,
      posture,
      // Present only in the OAuth posture, where it replaces the host guess with
      // the canonical URI the operator declared.
      resourceUrl: process.env.KOZOU_UI_MCP_RESOURCE,
    }),
  };
};
