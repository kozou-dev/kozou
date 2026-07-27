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
//
// In the OAuth posture that guess is replaced by the canonical resource URI the
// operator declared (`server.mcp.http.auth.resource`) — see
// {@link buildMcpConnectionInfo}. Guessing there would be wrong in the exact
// deployment that field exists for.

/** Default MCP HTTP port (matches `kozou dev` / `kozou mcp --http`). */
export const DEFAULT_MCP_HTTP_PORT = 3334;

/** Path the MCP Streamable HTTP transport is served at. */
export const MCP_HTTP_PATH = '/mcp';

/**
 * How the co-located MCP HTTP endpoint runs, as reported by `kozou dev` through
 * `KOZOU_UI_MCP_POSTURE`:
 *
 *   - `off`     — no listener (`server.mcp.http.enabled: false`); the page 404s;
 *   - `local`   — serving with no authentication (the loopback-default posture);
 *   - `oauth`   — serving as an OAuth 2.1 protected resource
 *                 (`server.mcp.http.auth`);
 *   - `unknown` — a value this build does not recognize: a typo in a
 *                 hand-written value, or a CLI newer than this Admin UI. Never
 *                 emitted by the CLI itself; see {@link resolveMcpPosture}.
 */
export type McpPosture = 'off' | 'local' | 'oauth' | 'unknown';

/** The postures that have an endpoint behind them, so the page renders. */
export type ServedMcpPosture = Exclude<McpPosture, 'off'>;

export interface McpConnectionInfo {
  /** The live MCP endpoint, e.g. `http://localhost:3334/mcp`. */
  httpUrl: string;
  /** Claude Code one-liner: `claude mcp add --transport http …`. */
  claudeCodeCommand: string;
  /** `mcpServers` JSON entry (HTTP transport) for Claude Desktop / Cursor. */
  jsonConfig: string;
  /** What to tell the operator about authentication, for this posture. */
  authNote: string;
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

/**
 * Read the endpoint's posture from `KOZOU_UI_MCP_POSTURE`.
 *
 * `kozou dev` sets this from its own config on every run, so it is a CLI-to-UI
 * channel, not an operator-facing knob — the operator sets
 * `server.mcp.http.enabled` / `server.mcp.http.auth` (or
 * `KOZOU_MCP_HTTP_ENABLED`, which `loadConfig` honours) and this follows.
 *
 * Absent reads as `local`: every other way of running the Admin UI (standalone
 * `node build/index.js`, the E2E suite, an older `kozou dev`) leaves it unset,
 * and that is the posture such a run is in — a UI started by hand next to the
 * default dev stack. It also keeps the pre-existing behaviour of offering the
 * page rather than hiding an endpoint that is in fact serving.
 *
 * An unrecognized value reads as `unknown`, which still offers the page — with
 * the request-derived URL, the same guess `local` gets — but says nothing about
 * authentication. Guessing `local` would assert "no authentication" about an
 * endpoint that may well have some, which is the defect this channel exists to
 * remove; resolving to `off` would hide a page for an endpoint that is in fact
 * serving. Two ways to get here: a value written by hand (the README documents
 * setting `off` for a standalone UI, and `of` / `none` / `false` are the typos
 * that follow), or a CLI newer than this build.
 */
export function resolveMcpPosture(raw: string | undefined): McpPosture {
  const value = raw?.trim().toLowerCase();
  if (value === undefined || value === '') return 'local';
  if (value === 'off' || value === 'local' || value === 'oauth') return value;
  return 'unknown';
}

/**
 * What to tell the operator about authentication, per posture. Lives here
 * rather than in the template so it is unit-testable (this package has no
 * component-test harness) and so the page stays declarative.
 */
export function describeMcpAuth(posture: ServedMcpPosture): string {
  switch (posture) {
    case 'oauth':
      return (
        'This endpoint is an OAuth 2.1 protected resource (server.mcp.http.auth): ' +
        'your client discovers the authorization server from the endpoint itself and ' +
        'sends you to your identity provider to sign in the first time it connects. ' +
        'No client secret goes in the config above — the URL is the canonical one ' +
        'you configured, so it is already right for a proxy or another machine.'
      );
    case 'local':
      return (
        'The MCP HTTP server has no authentication and binds to loopback by default, ' +
        'so anything that can reach the port can read your schema.'
      );
    case 'unknown':
      return (
        'Kozou reported an MCP posture this Admin UI does not recognize, so it cannot ' +
        'tell you how this endpoint authenticates — check KOZOU_UI_MCP_POSTURE for a ' +
        'typo, and server.mcp.http.auth in your config, before you expose the port.'
      );
  }
}

export function buildMcpConnectionInfo(input: {
  /** The browser's request URL to the Admin UI; only origin parts are used. */
  requestUrl: URL;
  /** Port the co-located MCP HTTP server listens on. */
  mcpPort: number;
  /** How that endpoint authenticates. Decides the wording — and, for `oauth`,
   *  that {@link resourceUrl} is what to register. */
  posture: ServedMcpPosture;
  /** The canonical resource URI (`server.mcp.http.auth.resource`), when the CLI
   *  reported one. Used verbatim, path included: it identifies the endpoint, it
   *  is not a host to append a path to. */
  resourceUrl?: string;
}): McpConnectionInfo {
  const { requestUrl, mcpPort, posture, resourceUrl } = input;
  // The OAuth posture has an address the operator declared, so stop guessing:
  // `resource` is explicit precisely because a proxy or tunnel makes the request
  // host wrong, and that is the deployment this posture describes. The other
  // postures have no declared URI, so the request host stays the best guess
  // (and an absent resource in `oauth` — which the schema does not allow —
  // falls back to it rather than rendering nothing).
  const canonical = posture === 'oauth' ? resourceUrl?.trim() : undefined;
  const httpUrl =
    canonical !== undefined && canonical !== ''
      ? canonical
      : `${requestUrl.protocol}//${requestUrl.hostname}:${mcpPort}${MCP_HTTP_PATH}`;
  const claudeCodeCommand = `claude mcp add --transport http kozou ${httpUrl}`;
  const jsonConfig = JSON.stringify(
    { mcpServers: { kozou: { type: 'http', url: httpUrl } } },
    null,
    2,
  );
  // The *shape* is identical across postures — one URL, no client secret, no
  // token field — because an MCP client discovers the authorization server from
  // the endpoint's RFC 9728 protected-resource metadata. The URL itself is not:
  // in `oauth` it is the declared canonical resource, everywhere else a guess
  // from the request host.
  return { httpUrl, claudeCodeCommand, jsonConfig, authNote: describeMcpAuth(posture) };
}
