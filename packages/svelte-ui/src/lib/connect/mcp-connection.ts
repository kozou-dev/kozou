// Builds the copy-paste connection snippets shown on the "Connect an AI agent"
// page. Pure (no Svelte / SvelteKit / Node) so it is unit-testable in isolation.
//
// kozou dev already serves the MCP Streamable HTTP endpoint alongside the Admin
// UI, so the lowest-friction path for a non-engineer is the HTTP transport:
// register a URL, no process to launch and — unlike the stdio path — no
// DATABASE_URL (or any secret) in the client config. The URL's host comes from
// the Admin UI's own request URL, which `kozou dev` binds to ORIGIN (default
// `localhost`); the MCP server is co-located on `mcpPort`. For the default
// local-dev / Docker stack that yields the correct `localhost:<port>/mcp`; an
// operator who reaches the UI through a different host (proxy/remote) adjusts
// the host (the page says so).

/** Default MCP HTTP port (matches `kozou dev` / `kozou mcp --http`). */
export const DEFAULT_MCP_HTTP_PORT = 3334;

/** Path the MCP Streamable HTTP transport is served at. */
export const MCP_HTTP_PATH = '/mcp';

export interface McpConnectionInfo {
  /** The live MCP endpoint, e.g. `http://localhost:3334/mcp`. */
  httpUrl: string;
  /** Claude Code one-liner: `claude mcp add --transport http …`. */
  claudeCodeCommand: string;
  /** `mcpServers` JSON entry (HTTP transport) for Claude Desktop / Cursor. */
  jsonConfig: string;
}

/**
 * Coerce a `KOZOU_MCP_HTTP_PORT` env string to a valid port, falling back to
 * the documented default for an absent / malformed / out-of-range value so the
 * page always renders a sane endpoint.
 */
export function resolveMcpHttpPort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_MCP_HTTP_PORT;
  const port = Number(raw);
  return Number.isInteger(port) && port >= 1 && port <= 65_535
    ? port
    : DEFAULT_MCP_HTTP_PORT;
}

export function buildMcpConnectionInfo(input: {
  /** The browser's request URL to the Admin UI; only origin parts are used. */
  requestUrl: URL;
  /** Port the co-located MCP HTTP server listens on. */
  mcpPort: number;
}): McpConnectionInfo {
  const { requestUrl, mcpPort } = input;
  const httpUrl = `${requestUrl.protocol}//${requestUrl.hostname}:${mcpPort}${MCP_HTTP_PATH}`;
  const claudeCodeCommand = `claude mcp add --transport http kozou ${httpUrl}`;
  const jsonConfig = JSON.stringify(
    { mcpServers: { kozou: { type: 'http', url: httpUrl } } },
    null,
    2,
  );
  return { httpUrl, claudeCodeCommand, jsonConfig };
}
