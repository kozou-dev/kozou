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
// That guess only holds while nothing sits between the browser and the
// listener. Where something does — a published-port remap, a tunnel, a
// devcontainer, a reverse proxy — the operator declares the reachable address
// and it replaces the guess: `server.mcp.http.auth.resource` in the OAuth
// posture, `server.mcp.http.advertisedUrl` where there is no auth block. See
// {@link buildMcpConnectionInfo}. Guessing in those deployments would be wrong
// in exactly the case those fields exist for.

/** Default MCP HTTP port (matches `kozou dev` / `kozou mcp --http`). */
export const DEFAULT_MCP_HTTP_PORT = 3334;

/** Path the MCP Streamable HTTP transport is served at. */
export const MCP_HTTP_PATH = '/mcp';

/**
 * How the co-located MCP HTTP endpoint runs, as reported by `kozou dev` through
 * `KOZOU_UI_MCP_POSTURE`:
 *
 *   - `off`     — no listener (`server.mcp.http.enabled: false`); the page 404s;
 *   - `local`   — serving with no authentication (the posture says nothing
 *                 about the bind host; the channel has no second axis);
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
  /** Where {@link httpUrl} came from, and what to do if it is not reachable. */
  addressNote: string;
}

/** Which declared field supplied the address, or `null` when it was guessed. */
export type McpAddressSource = 'auth.resource' | 'advertisedUrl' | null;

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
 * An unrecognized value reads as `unknown`, which still offers the page — the
 * address is resolved the same way `local` resolves it, a declared
 * `advertisedUrl` if the CLI reported one and the request host otherwise — but
 * says nothing about authentication. Guessing `local` would assert "no
 * authentication" about an
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
      // Silent about where the endpoint listens and about how far it can be
      // reached, because this package can know neither and both were got
      // wrong here before. "Binds to loopback by default" contradicted the
      // shipped compose stacks, which set KOZOU_MCP_HTTP_HOST=0.0.0.0. A
      // pointer at the bind host was no better: in that same deployment the
      // bind host is 0.0.0.0 while reach is decided by the compose port
      // publishing (127.0.0.1), and an Admin UI started on its own has no
      // CLI output to point at. What is left is what holds in every posture
      // this note renders in.
      return (
        'The MCP HTTP server has no authentication, so anything that can reach the port ' +
        'can read your schema.'
      );
    case 'unknown':
      return (
        'Kozou reported an MCP posture this Admin UI does not recognize, so it cannot ' +
        'tell you how this endpoint authenticates — check KOZOU_UI_MCP_POSTURE for a ' +
        'typo, and server.mcp.http.auth in your config, before you expose the port.'
      );
  }
}

/**
 * Where the URL came from, and what to do about it. Lives here for the same
 * reason as {@link describeMcpAuth}: the template used to carry one fixed
 * sentence saying the URL was built from the configured host and the MCP port,
 * and telling the operator to adjust the host. That became false the moment a
 * declared address replaced the guess — and worse than false, since it sends
 * the operator away from the address they declared, in the one deployment the
 * declaration exists for.
 */
export function describeMcpAddress(
  posture: ServedMcpPosture,
  source: McpAddressSource,
): string {
  if (source !== null) {
    return (
      `The URL above is the address you declared (server.mcp.http.${source}), handed ` +
      'over unchanged — register it exactly as it appears. The host you reached this ' +
      'page on does not affect it.'
    );
  }
  // Which field to point at depends on the posture: an OAuth endpoint declares
  // its address as part of being one, and the schema requires it, so reaching
  // here in that posture means something is wrong rather than unset.
  const field = posture === 'oauth' ? 'server.mcp.http.auth.resource' : 'server.mcp.http.advertisedUrl';
  return (
    'The URL above is built from the host you reached this page on and the port Kozou ' +
    'binds the MCP endpoint to. If clients reach that endpoint at a different address — ' +
    'through a proxy or a tunnel, or because the published port was remapped — set ' +
    `${field} to the address they should use, and this page will hand out that instead.`
  );
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
  /** The declared reachable address (`server.mcp.http.advertisedUrl`), when the
   *  CLI reported one. Same verbatim contract as {@link resourceUrl}, for the
   *  postures that have no auth block. */
  advertisedUrl?: string;
}): McpConnectionInfo {
  const { requestUrl, mcpPort, posture, resourceUrl, advertisedUrl } = input;
  // Prefer whatever address the operator declared, in every posture. Which
  // field carries it depends on the posture — `resource` where an auth block
  // exists (it is what the endpoint's own RFC 9728 metadata names, so it is
  // what clients obey), `advertisedUrl` where none does — but the reason is
  // the same in both: the request host plus the bind port is a guess, and it
  // is wrong in exactly the deployments these fields exist for. The posture
  // decides which field is read — that is a precedence rule, and it points at
  // `resource` in the OAuth posture because clients discover that one from the
  // endpoint itself. The schema also refuses the two together, so in practice
  // only one ever arrives; this stays exclusive regardless, because a config
  // object built directly bypasses the schema.
  //
  // Absent a declared address the request host remains the best guess, which
  // is right for the default local stack and said to be a guess on the page.
  const declared = posture === 'oauth' ? resourceUrl : advertisedUrl;
  const canonical = declared?.trim();
  const hasDeclared = canonical !== undefined && canonical !== '';
  const httpUrl = hasDeclared
    ? canonical
    : `${requestUrl.protocol}//${requestUrl.hostname}:${mcpPort}${MCP_HTTP_PATH}`;
  const addressSource: McpAddressSource = !hasDeclared
    ? null
    : posture === 'oauth'
      ? 'auth.resource'
      : 'advertisedUrl';
  const claudeCodeCommand = `claude mcp add --transport http kozou ${httpUrl}`;
  const jsonConfig = JSON.stringify(
    { mcpServers: { kozou: { type: 'http', url: httpUrl } } },
    null,
    2,
  );
  // The *shape* is identical across postures — one URL, no client secret, no
  // token field — because an MCP client discovers the authorization server from
  // the endpoint's RFC 9728 protected-resource metadata. The URL itself is not:
  // it is whichever address the operator declared, and a guess from the request
  // host only when they declared none.
  return {
    httpUrl,
    claudeCodeCommand,
    jsonConfig,
    authNote: describeMcpAuth(posture),
    addressNote: describeMcpAddress(posture, addressSource),
  };
}
