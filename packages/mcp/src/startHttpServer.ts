// Convenience helper to start an MCP server with the Streamable HTTP
// transport. Mirrors startStdioServer so callers
// (the bundled kozou CLI and adopters embedding the server) do not need
// to depend on @modelcontextprotocol/sdk or node:http directly.
//
// Design notes:
//   - The server is *stateful*: an MCP client initialises a session, the
//     transport issues an `mcp-session-id`, and subsequent requests reuse
//     the matching transport. This is the transport mode the standard MCP
//     client (Claude Desktop / Claude Code) speaks. Sessions are torn
//     down on transport close so nothing accumulates.
//   - Cache invalidation is exposed over HTTP via `POST /admin/refresh`,
//     the HTTP-mode counterpart to the stdio
//     server's SIGHUP handler.
//   - Without the `auth` option the MCP HTTP endpoint has **no
//     authentication**, so the server binds to localhost by default and
//     prints a loud warning when bound to a non-loopback host. By default the
//     tools only expose schema metadata (no SQL execution, no data access),
//     which bounds the blast radius. When the operator enables the `call`
//     execution tool the blast radius is no longer bounded to metadata — the
//     warning escalates accordingly — so execution + a non-loopback bind must
//     be avoided unless an external auth/proxy layer is in front.
//   - With the `auth` option the server is an OAuth 2.1 resource server
//     (MCP authorization spec): it advertises the operator's authorization
//     server via RFC 9728 protected-resource metadata, challenges
//     tokenless requests with 401 + WWW-Authenticate, verifies each
//     request's bearer token (signature / issuer / audience / role), and
//     gates the describe and execute tool facets on the token's scopes.
//     This is the sanctioned posture for a non-loopback bind.

import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { KozouAuthError } from '@kozou/core/auth';

import { createMcpServer } from './server.js';
import type { SchemaCache } from './schemaCache.js';
import { fixedIdentity, type McpExecution } from './execution.js';
import {
  authenticateRequest,
  isLoopbackUrl,
  resolveMcpHttpAuth,
  type McpAuthContext,
  type McpHttpAuth,
  type McpHttpAuthOptions,
} from './httpAuth.js';

export type StartHttpServerOptions = {
  /** TCP port to listen on. Default: 3334. */
  port?: number;
  /** Host/interface to bind. Default: 127.0.0.1 (loopback only). */
  host?: string;
  /** Path that serves the MCP Streamable HTTP endpoint. Default: '/mcp'. */
  mcpPath?: string;
  /** Prefix used in stderr log lines. Default: '[@kozou/mcp]'. */
  logPrefix?: string;
  /** Opt-in execution capability for the `call` tool. Omit = describe-only.
   *  The HTTP transport has NO authentication, so when this is set on a
   *  non-loopback bind the startup warning is escalated: anyone who can reach
   *  the host could execute exposed functions as the execution role. */
  execution?: McpExecution;
  /** Opt-in: stamp read/describe tool results with a `provenance` object
   *  ({ databaseVersion, kozouVersion, builtAt }). Emit-only; default off. */
  provenance?: boolean;
  /** Additional hostnames the DNS-rebinding guard accepts in the `Host` header.
   *  Matching is on the hostname alone and is port-agnostic, so a `host:port`
   *  entry contributes its host part. The guard always accepts the loopback
   *  names; a specific non-loopback bind adds its own hostname, and OAuth mode
   *  or `advertisedUrl` adds the declared public hostname. Pass this for what
   *  neither covers: a second valid external path, or an internal name that
   *  also reaches the endpoint. */
  allowedHosts?: string[];
  /** Override the set of `Origin` header values accepted by the DNS-rebinding
   *  guard. When omitted it mirrors the allowed hosts under `http://`. Requests
   *  with no `Origin` header (the usual non-browser MCP client) are always
   *  allowed; the guard only rejects a *present* Origin that is not allowed. */
  allowedOrigins?: string[];
  /** Maximum accepted request body size in bytes. The endpoint has no
   *  authentication, so an unbounded body would let any reachable client drive
   *  the process toward OOM. Default: 1 MiB (MCP messages are small). A request
   *  whose `Content-Length` exceeds this, or that streams past it, is rejected
   *  with 413. */
  maxBodyBytes?: number;
  /** The address clients reach this endpoint at, when a tunnel, a reverse proxy
   *  or a port remap makes that different from the bind address. Its hostname is
   *  added to the DNS-rebinding guard — a declared value, never derived from a
   *  header, and exactly the name a tunnel or proxy forwards unless it is
   *  configured to rewrite it. Without this, a loopback-bound server behind a
   *  `Host`-preserving tunnel or proxy refuses every request. Refused together with `auth`, whose `resource` already declares
   *  the address (and is the one clients obey, since they discover it from the
   *  endpoint's own metadata). */
  advertisedUrl?: string;
  /** Run as an OAuth 2.1 resource server (MCP authorization spec): serve
   *  RFC 9728 protected-resource metadata, require a verified bearer token
   *  on the MCP endpoint, and gate the tool facets on the token's scopes.
   *  The resource URI's hostname is added to the DNS-rebinding guard. Omit
   *  = the historical no-auth loopback mode. */
  auth?: McpHttpAuthOptions;
};

/** The DNS-rebinding guard: the hostnames this server accepts in the `Host`
 *  (and, by default, `Origin`) header. `allowedOrigins`, when set, is an exact
 *  Origin allowlist that replaces the hostname-based Origin check. */
type RebindingGuard = { hostnames: Set<string>; allowedOrigins?: Set<string> };

export type HttpServerHandle = {
  /** The actual bound port (resolves an ephemeral `0` to the real port). */
  port: number;
  /** The host the server is bound to. */
  host: string;
  /** Stop accepting connections and resolve once the server has closed. */
  close: () => Promise<void>;
};

const DEFAULT_PORT = 3334;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_MCP_PATH = '/mcp';
const REFRESH_PATH = '/admin/refresh';
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024; // 1 MiB

/** A client-error in reading the request body (oversized, or wrong media
 *  type), carrying the HTTP status to return. */
class HttpBodyError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpBodyError';
  }
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1']);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

const BIND_ALL_HOSTS = new Set(['0.0.0.0', '::', '']);
const LOOPBACK_HOSTNAMES = ['127.0.0.1', 'localhost', '::1'];

/** The hostname portion of a `Host` header value, lowercased (hostnames are
 *  case-insensitive) with the port and any IPv6 brackets removed:
 *  `127.0.0.1:3334` -> `127.0.0.1`, `[::1]:3334` -> `::1`, `LOCALHOST` ->
 *  `localhost`. */
function hostnameOf(value: string): string {
  // A single trailing dot names the same host (the absolute form of the FQDN),
  // so it is stripped on both sides of the comparison: an `advertisedUrl` of
  // `https://mcp.example.com./mcp` must still match `Host: mcp.example.com`.
  const dropRootDot = (h: string): string => (h.length > 1 && h.endsWith('.') ? h.slice(0, -1) : h);
  const stripped = value.startsWith('[')
    ? (() => {
        const end = value.indexOf(']');
        return end === -1 ? value : value.slice(1, end);
      })()
    : (() => {
        const colon = value.indexOf(':');
        return colon === -1 ? value : value.slice(0, colon);
      })();
  return dropRootDot(stripped.toLowerCase());
}

/** Build the DNS-rebinding guard for a server bound to `host`. The MCP HTTP
 *  transport has no authentication, so without a Host/Origin check a web page
 *  in the operator's browser could rebind a name it controls to the loopback
 *  address and drive this endpoint. The browser sets `Host` (and `Origin`)
 *  honestly from the page URL and cannot be made to forge them, so refusing a
 *  request whose hostname is not allowed defeats the rebinding vector.
 *
 *  This is *only* a browser-rebinding defence — it is not network access
 *  control. A non-browser client (curl, a LAN process) can send any `Host`, so
 *  reachability of a no-auth server must be constrained by the network (bind /
 *  publish on loopback), not by this header check.
 *
 *  Matching is on the *hostname* (port-agnostic): a rebinding request carries
 *  the attacker's hostname while the port is just whatever the server listens
 *  on, and a port-pinned check would break behind Docker port mapping. Loopback
 *  names are always accepted; a specific bound host and any `allowedHosts` are
 *  added. */
export function buildRebindingGuard(
  host: string,
  opts: { allowedHosts?: string[]; allowedOrigins?: string[] } = {},
): RebindingGuard {
  const hostnames = new Set<string>(LOOPBACK_HOSTNAMES);
  if (!isLoopbackHost(host) && !BIND_ALL_HOSTS.has(host)) {
    hostnames.add(hostnameOf(host));
  }
  for (const h of opts.allowedHosts ?? []) hostnames.add(hostnameOf(h));
  const allowedOrigins =
    opts.allowedOrigins && opts.allowedOrigins.length > 0 ? new Set(opts.allowedOrigins) : undefined;
  return { hostnames, allowedOrigins };
}

/** Why an `allowedHosts` entry cannot name a host, or undefined when it can.
 *  Exported so the CLI validates against this same predicate rather than a
 *  second copy of it: the CLI can then report the offending key and the env var
 *  it came from, while this package still refuses an embedder's bad input.
 *
 *  The sibling key `advertisedUrl` takes a full URL, so a URL or a path lands
 *  here by habit — and would otherwise be accepted, contribute a garbage
 *  hostname, and leave every request refused with nothing said. An entry whose
 *  hostname comes out empty is worse than useless: it would admit a request
 *  that carries an empty `Host` header. */
/** Why a parsed `advertisedUrl` cannot be an address a client registers, or
 *  undefined when it can. Exported so the CLI checks the same predicate rather
 *  than a second copy: this key exists to stop the endpoint handing out an
 *  address nothing answers on, so a value no client can use is the failure it
 *  was added to prevent, not a lesser version of it. */
export function unusableAdvertisedUrlReason(url: URL): string | undefined {
  if (url.username !== '' || url.password !== '') {
    // It would also be echoed into the startup log, which is a credential in a
    // place nobody expects one.
    return 'it carries userinfo (credentials), which is not part of an endpoint address';
  }
  const host = url.hostname.startsWith('[') && url.hostname.endsWith(']')
    ? url.hostname.slice(1, -1)
    : url.hostname;
  if (host === '0.0.0.0' || host === '::' || host === '') {
    return `"${url.hostname}" is a bind-all address, not somewhere a client can connect`;
  }
  return undefined;
}

export function unusableAllowedHostReason(entry: string): string | undefined {
  if (entry.includes('/') || entry.includes('@')) {
    return 'it is a URL or carries a path — this takes a bare hostname, optionally with a port';
  }
  return hostnameOf(entry) === '' ? 'no hostname can be read from it' : undefined;
}

function assertUsableAllowedHosts(entries: readonly string[], prefix: string): void {
  for (const entry of entries) {
    const why = unusableAllowedHostReason(entry);
    if (why !== undefined) {
      throw new Error(`${prefix} allowedHosts entry "${entry}" is not usable: ${why}.`);
    }
  }
}

/** The `advertisedUrl` as a URL, or undefined when it is not set.
 *  Validated here against the same set of refusals the CLI config applies — not
 *  a subset — so a library embedder cannot boot with a value `kozou dev` would
 *  have rejected. The value exists to replace a guess, so a malformed one has
 *  no honest fallback. */
function resolveAdvertisedUrl(
  opts: StartHttpServerOptions,
  prefix: string,
): URL | undefined {
  if (opts.advertisedUrl === undefined) return undefined;
  if (opts.auth !== undefined) {
    throw new Error(
      `${prefix} advertisedUrl is set alongside auth, which already declares the endpoint's ` +
        "address as auth.resource — and that is the one clients obey, since they discover it " +
        'from the metadata. Drop advertisedUrl and set auth.resource to the reachable URL.',
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(opts.advertisedUrl);
  } catch {
    throw new Error(
      `${prefix} advertisedUrl "${opts.advertisedUrl}" is not an absolute URL.`,
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${prefix} advertisedUrl must be an http(s) URL, got ${parsed.protocol}.`);
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    throw new Error(
      `${prefix} advertisedUrl must not carry a query or fragment — the transport matches on ` +
        'path alone and a fragment never leaves the client.',
    );
  }
  if (parsed.pathname !== DEFAULT_MCP_PATH) {
    throw new Error(
      `${prefix} advertisedUrl must have the path ${DEFAULT_MCP_PATH} exactly (got ` +
        `"${parsed.pathname}") — the transport serves that path and no other.`,
    );
  }
  const unusable = unusableAdvertisedUrlReason(parsed);
  if (unusable !== undefined) {
    // The value is deliberately not echoed: one of the reasons this fires is
    // that it carries credentials, and repeating them into the log is the leak
    // the refusal exists to prevent. Each reason names what it needs to.
    throw new Error(`${prefix} advertisedUrl is not usable: ${unusable}.`);
  }
  return parsed;
}

/** Returns a rejection reason when the request's Host/Origin is not allowed by
 *  the guard, or null when the request may proceed. The Host header must be
 *  present and its hostname allowed. A *present* Origin must be allowed too
 *  (exact match when `allowedOrigins` is set, else its hostname must be
 *  allowed); a missing Origin — the usual non-browser MCP client — is fine. */
export function validateRebindingHeaders(
  req: IncomingMessage,
  guard: RebindingGuard,
): string | null {
  const host = headerValue(req.headers.host);
  // Defense in depth: an empty hostname is refused whatever the guard set
  // holds. `Host:` with no value names nothing, so admitting it could only come
  // from a bad entry in the set — which `assertUsableAllowedHosts` now refuses
  // at startup, leaving this reachable only if guard construction regresses.
  // Exported alongside `buildRebindingGuard` so that stays asserted rather than
  // assumed.
  const hostname = host === undefined ? undefined : hostnameOf(host);
  if (hostname === undefined || hostname === '' || !guard.hostnames.has(hostname)) {
    return 'Host header is not allowed for this server.';
  }
  const origin = headerValue(req.headers.origin);
  if (origin !== undefined) {
    if (guard.allowedOrigins !== undefined) {
      if (!guard.allowedOrigins.has(origin)) return 'Origin is not allowed for this server.';
    } else {
      let originHostname: string | undefined;
      try {
        originHostname = new URL(origin).hostname;
      } catch {
        originHostname = undefined;
      }
      if (originHostname === undefined || !guard.hostnames.has(originHostname)) {
        return 'Origin is not allowed for this server.';
      }
    }
  }
  return null;
}

function nonLoopbackWarning(host: string, prefix: string, executionRole?: string): string {
  const head =
    `${prefix} WARNING: MCP HTTP server bound to non-loopback host "${host}".\n` +
    `${prefix} The MCP HTTP server has NO authentication.\n`;
  const tail =
    `${prefix} Bind to 127.0.0.1 (the default) unless you have a trusted network\n` +
    `${prefix} and an external auth/proxy layer in front.\n`;
  // With execution enabled the blast radius is no longer schema metadata: any
  // client that can reach the host can run exposed functions as the execution
  // role. Make that explicit and louder.
  if (executionRole !== undefined) {
    return (
      head +
      `${prefix} The \`call\` execution tool is ENABLED: anyone who can reach\n` +
      `${prefix} ${host} can execute exposed database functions as the\n` +
      `${prefix} "${executionRole}" role. This is dangerous on a public interface.\n` +
      tail
    );
  }
  return head + `${prefix} Anyone who can reach ${host} can read this database's schema metadata.\n` + tail;
}

/** The endpoint declares an off-box reachable address and runs no
 *  authentication of its own. The bind-address warning cannot cover this: the
 *  standard tunnel and reverse-proxy shape binds loopback, so the loudest
 *  deployment is the quietest one. Says "of its own" because kozou cannot see
 *  whether something in front authenticates — the remedy names that path too.
 *
 *  The remedy has to be the one that actually boots: `advertisedUrl` is refused
 *  alongside `auth`, so "add auth" alone would send the operator into a startup
 *  error. The address has to move, not be duplicated.
 */
function advertisedNoAuthWarning(
  advertised: URL,
  prefix: string,
  executionRole?: string,
): string {
  const lines = [
    `WARNING: this endpoint is declared reachable at "${advertised.href}",`,
    'which is not a local address, and it runs no authentication of its own.',
  ];
  if (advertised.protocol === 'http:') {
    // Named rather than refused: kozou neither requires nor issues a token for
    // this address, and serves no metadata that would send one, so plaintext is
    // a smaller problem here than on the OAuth side. It stops being smaller the
    // moment an authenticating layer sits in front — hence the remedy's https.
    lines.push('The advertised address is plaintext http, so requests and');
    lines.push('responses cross the network unencrypted.');
  }
  if (executionRole === undefined) {
    lines.push("Anyone who can reach it can read this database's schema metadata");
    lines.push('and force a schema re-read (POST /admin/refresh is open in this mode).');
  } else {
    lines.push('The `call` execution tool is ENABLED: anyone who can reach it can');
    lines.push(`execute exposed database functions as the "${executionRole}" role,`);
    lines.push('which is the single identity every caller shares here, and can force');
    lines.push('a schema re-read (POST /admin/refresh is open in this mode).');
  }
  lines.push('To authenticate each caller: move this address to auth.resource, drop');
  lines.push('advertisedUrl (the two are refused together) and configure');
  lines.push('server.mcp.http.auth. Otherwise keep the address private, or front it');
  lines.push('with a layer that authenticates before kozou sees the request — over');
  lines.push('https, since credentials would then cross this address too.');
  return lines.map((line) => `${prefix} ${line}\n`).join('');
}

/** OAuth mode on a non-loopback bind. The bind warning is suppressed there for
 *  good reason — its "NO authentication" line would be false — but suppressing
 *  it removed the one hazard that OAuth mode adds rather than removes: this
 *  listener speaks plaintext http, so a token sent straight to the port is not
 *  encrypted, however the advertised resource URI is spelled.
 *
 *  A NOTE, not a WARNING. Loopback-bound-behind-a-TLS-proxy is the documented
 *  shape and both shipped Compose stacks bind 0.0.0.0 inside a container, so a
 *  warning here would fire on the sanctioned deployment every time — the same
 *  desensitization the advertised-value refusals exist to avoid.
 */
function oauthPlaintextBindNote(host: string, prefix: string): string {
  return (
    `${prefix} NOTE: OAuth mode bound to non-loopback host "${host}". This listener\n` +
    `${prefix} speaks plaintext http — kozou terminates no TLS of its own — so a bearer\n` +
    `${prefix} token sent straight to this port crosses the network unencrypted, whatever\n` +
    `${prefix} scheme the advertised resource URI uses.\n` +
    `${prefix} Terminate TLS in front of it, and let nothing reach this port except\n` +
    `${prefix} through that path.\n`
  );
}

/** Divergences between the advertised `iss` / `aud` contract and the one
 *  actually verified, formatted for a startup warning. Scoped to those two
 *  claims on purpose — the verification key (`jwt.jwksUri`) can point
 *  somewhere else again, and nothing here checks that. */
function advertisementDivergenceWarning(divergences: string[], prefix: string): string {
  return (
    `${prefix} WARNING: the token issuer/audience this server accepts is not the one it\n` +
    `${prefix} advertises in its protected-resource metadata.\n` +
    divergences.map((divergence) => `${prefix}   - ${divergence}\n`).join('') +
    `${prefix} Make auth.jwt and the advertised values agree — whichever side is the wrong\n` +
    `${prefix} one — unless every line above is deliberate.\n`
  );
}

/** The audience escape hatch, formatted for a startup note. Deliberately not
 *  a warning: the operator guide tells an operator whose IdP cannot mint the
 *  resource URI as `aud` to configure exactly this, so a deployment that
 *  followed the documentation must not boot into a permanent WARNING. The
 *  note states what follows from it, so the choice stays a conscious one. */
function advertisementNote(notes: string[], prefix: string): string {
  return (
    `${prefix} NOTE: this server accepts an audience other than the resource URI it\n` +
    `${prefix} advertises — the supported shape when an IdP cannot mint that URI as \`aud\`.\n` +
    notes.map((note) => `${prefix}   - ${note}\n`).join('')
  );
}

/**
 * Start the MCP server over Streamable HTTP, bound to the given
 * SchemaCache. Resolves once the server is listening.
 *
 * Routes:
 *   - `<mcpPath>` (default `/mcp`)  — MCP Streamable HTTP endpoint
 *   - `POST /admin/refresh`         — invalidate the schema cache
 */
export async function startHttpServer(
  cache: SchemaCache,
  opts: StartHttpServerOptions = {},
): Promise<HttpServerHandle> {
  const prefix = opts.logPrefix ?? '[@kozou/mcp]';
  const host = opts.host ?? DEFAULT_HOST;
  const port = opts.port ?? DEFAULT_PORT;
  const mcpPath = opts.mcpPath ?? DEFAULT_MCP_PATH;

  // Resolve the OAuth resource-server state up front so misconfiguration is
  // a startup error, never a per-request one.
  const auth = opts.auth === undefined ? undefined : resolveMcpHttpAuth(opts.auth, mcpPath);

  // The declared reachable address of a deployment that runs no OAuth. Both
  // declare the same fact, so both together is a contradiction rather than
  // something to resolve silently.
  const advertised = resolveAdvertisedUrl(opts, prefix);
  if (opts.allowedHosts !== undefined) assertUsableAllowedHosts(opts.allowedHosts, prefix);

  if (auth !== undefined && auth.insecureHttpUrls.length > 0) {
    process.stderr.write(
      `${prefix} WARNING: allowInsecureHttp is set — advertising plaintext http URL(s) ` +
        `${auth.insecureHttpUrls.join(', ')}; bearer tokens cross the network unencrypted.\n`,
    );
  }

  if (auth !== undefined && auth.advertisementDivergences.length > 0) {
    process.stderr.write(advertisementDivergenceWarning(auth.advertisementDivergences, prefix));
  }

  if (auth !== undefined && auth.advertisementNotes.length > 0) {
    process.stderr.write(advertisementNote(auth.advertisementNotes, prefix));
  }

  if (opts.execution !== undefined) {
    if (auth === undefined) {
      // Fail fast: a no-auth server with execution needs its fixed identity.
      fixedIdentity(opts.execution, prefix);
    } else {
      // The same allowlist requirement the kozou CLI enforces at the config
      // level: the token's role claim selects the execution role, so OAuth
      // mode with execution demands an explicit non-empty allowedRoles.
      // Enforced here too — a direct embedder of this package never passes
      // through that config validation.
      if (opts.auth?.allowedRoles === undefined || opts.auth.allowedRoles.length === 0) {
        throw new Error(
          '@kozou/mcp auth: execution with OAuth resource-server auth requires a non-empty ' +
            "auth.allowedRoles — the token's role claim selects the execution role, so the " +
            'assumable roles must be an explicit allowlist.',
        );
      }
      if (opts.execution.role !== undefined) {
        process.stderr.write(
          `${prefix} NOTE: execution.role ("${opts.execution.role}") is ignored in OAuth mode — ` +
            `the \`call\` tool runs as each verified token's role.\n`,
        );
      }
    }
  }

  if (!isLoopbackHost(host) && auth === undefined) {
    process.stderr.write(nonLoopbackWarning(host, prefix, opts.execution?.role));
  }

  // The other half of that condition. Authenticating the caller does not encrypt
  // the socket, and this one never was: kozou serves plain http.
  if (!isLoopbackHost(host) && auth !== undefined) {
    process.stderr.write(oauthPlaintextBindNote(host, prefix));
  }

  // A separate fact from the bind address, and the one the bind warning cannot
  // reach: `advertisedUrl` is refused alongside `auth`, so an off-box declared
  // address here always means an endpoint kozou does not authenticate.
  if (advertised !== undefined && !isLoopbackUrl(advertised)) {
    process.stderr.write(advertisedNoAuthWarning(advertised, prefix, opts.execution?.role));
  }

  // Active MCP sessions, keyed by the transport-issued session id.
  const transports = new Map<string, StreamableHTTPServerTransport>();

  // The DNS-rebinding guard is hostname-based and known up front; build it here
  // so the request handler (which only runs after listen()) closes over it. The
  // declared public hostname is allowed automatically — in OAuth mode the
  // canonical resource's, otherwise `advertisedUrl`'s. Either way it is
  // config-declared (never derived from a header), and it is exactly the name a
  // tunnel / reverse proxy forwards. The two are mutually exclusive, so at most
  // one of them contributes.
  const guard = buildRebindingGuard(host, {
    allowedHosts: [
      ...(opts.allowedHosts ?? []),
      ...(auth === undefined ? [] : [auth.resource.hostname]),
      ...(advertised === undefined ? [] : [advertised.hostname]),
    ],
    ...(opts.allowedOrigins === undefined ? {} : { allowedOrigins: opts.allowedOrigins }),
  });

  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  const httpServer = createServer((req, res) => {
    handleRequest(
      req,
      res,
      cache,
      mcpPath,
      transports,
      opts.execution,
      guard,
      maxBodyBytes,
      auth,
      opts.provenance ?? false,
    ).catch(
      (err) => {
        // Never echo the raw error to the client (it can carry stack/database
        // detail); log it server-side and return a generic message.
        process.stderr.write(
          `${prefix} request failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        respondError(res, 500, 'Internal server error.');
      },
    );
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    httpServer.once('error', onError);
    httpServer.listen(port, host, () => {
      httpServer.removeListener('error', onError);
      resolve();
    });
  });

  const boundPort = (httpServer.address() as AddressInfo).port;
  const refreshNote =
    auth === undefined
      ? `refresh: POST ${REFRESH_PATH}`
      : auth.adminRefresh
        ? `refresh: POST ${REFRESH_PATH} ("${auth.scopes.admin}" scope)`
        : 'refresh: disabled';
  process.stderr.write(
    `${prefix} MCP HTTP listening on http://${host}:${boundPort}` +
      ` (MCP: ${mcpPath}, ${refreshNote})\n`,
  );
  if (auth !== undefined) {
    process.stderr.write(
      `${prefix} OAuth 2.1 resource server mode: resource=${auth.resource.href}, ` +
        `authorization servers=[${opts.auth?.authorizationServers.join(', ') ?? ''}], ` +
        `scopes: describe="${auth.scopes.describe}" execute="${auth.scopes.execute}"\n`,
    );
  }
  process.stderr.write(
    `${prefix} DNS-rebinding guard: accepting Host names ${[...guard.hostnames].join(', ')}` +
      ` (add more with server.mcp.http.allowedHosts)\n`,
  );

  return {
    port: boundPort,
    host,
    close: async () => {
      for (const transport of transports.values()) {
        await transport.close();
      }
      transports.clear();
      await closeServer(httpServer);
    },
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  cache: SchemaCache,
  mcpPath: string,
  transports: Map<string, StreamableHTTPServerTransport>,
  execution: McpExecution | undefined,
  guard: RebindingGuard,
  maxBodyBytes: number,
  auth: McpHttpAuth | undefined,
  provenance: boolean,
): Promise<void> {
  // DNS-rebinding guard: reject requests whose Host/Origin is not allowed
  // before doing any work, covering every route (the MCP endpoint and
  // /admin/refresh, both of which a rebound page could otherwise drive).
  const rejection = validateRebindingHeaders(req, guard);
  if (rejection !== null) {
    respondError(res, 403, rejection);
    return;
  }

  // Reject an over-large body up front when the client declares its size, so a
  // huge declared payload is refused before any of it is buffered. This guards
  // every route, including requests the SDK transport reads itself.
  const declared = Number(headerValue(req.headers['content-length']));
  if (Number.isFinite(declared) && declared > maxBodyBytes) {
    respondError(res, 413, 'Request body too large.');
    return;
  }

  const url = new URL(req.url ?? '/', 'http://localhost');

  // RFC 9728 protected-resource metadata: public by design (it exists so an
  // unauthenticated client can discover the authorization server), and free
  // of any schema information. Served on the root well-known path and the
  // path-insertion forms — real clients derive either from the endpoint URL.
  if (auth !== undefined && auth.prmPaths.has(url.pathname)) {
    if (req.method !== 'GET') {
      respondError(res, 405, 'Method Not Allowed: metadata is GET-only.');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(auth.prmBody);
    return;
  }

  if (url.pathname === REFRESH_PATH) {
    if (auth !== undefined && !auth.adminRefresh) {
      // Disabled in auth mode unless the operator opted in; indistinguishable
      // from an unknown path so the surface does not advertise itself.
      respondError(res, 404, `Not Found: ${url.pathname}`);
      return;
    }
    if (req.method !== 'POST') {
      respondError(res, 405, 'Method Not Allowed: use POST /admin/refresh');
      return;
    }
    if (auth !== undefined) {
      const ctx = await authenticate(auth, req, res);
      if (ctx === undefined) return; // response already written
      if (!ctx.scopes.has(auth.scopes.admin)) {
        respondInsufficientScope(res, auth, auth.scopes.admin);
        return;
      }
    }
    cache.invalidate();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (url.pathname === mcpPath) {
    let authCtx: McpAuthContext | undefined;
    if (auth !== undefined) {
      authCtx = await authenticate(auth, req, res);
      if (authCtx === undefined) return; // response already written
      // A token carrying neither MCP facet scope can do nothing here; refuse
      // up front with the challenge a scope-upgrade-capable client expects.
      if (!authCtx.scopes.has(auth.scopes.describe) && !authCtx.scopes.has(auth.scopes.execute)) {
        respondInsufficientScope(res, auth, auth.scopes.describe);
        return;
      }
      // Hand the verified identity to the SDK transport, which surfaces it to
      // the request handlers as `extra.authInfo` (tool filtering + per-token
      // execution identity).
      (req as IncomingMessage & { auth?: AuthInfo }).auth = {
        token: authCtx.token,
        clientId: clientIdOf(authCtx.claims),
        scopes: [...authCtx.scopes],
        ...(typeof authCtx.claims.exp === 'number' ? { expiresAt: authCtx.claims.exp } : {}),
        extra: { role: authCtx.role, claims: authCtx.claims },
      };
    }
    await handleMcp(req, res, cache, transports, execution, maxBodyBytes, auth, authCtx, provenance);
    return;
  }

  respondError(res, 404, `Not Found: ${url.pathname}`);
}

/** Verify the request's bearer token. On failure the 401/403 response —
 *  including the RFC 9728 WWW-Authenticate challenge pointing at the
 *  protected-resource metadata — is written here and `undefined` is
 *  returned. Messages come from KozouAuthError and are safe by contract
 *  (they never say which verification check failed). */
async function authenticate(
  auth: McpHttpAuth,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<McpAuthContext | undefined> {
  try {
    return await authenticateRequest(auth, req);
  } catch (err) {
    if (err instanceof KozouAuthError) {
      if (err.kind === 'unauthorized') {
        // RFC 6750: no error attribute when the request had no credentials.
        const hadToken = req.headers.authorization !== undefined;
        respondChallenge(res, 401, err.message, challengeHeader(auth, hadToken ? 'invalid_token' : undefined));
        return undefined;
      }
      // A role problem (missing claim / not allowed) is forbidden, not a
      // scope-upgrade situation — no insufficient_scope challenge.
      respondError(res, 403, err.message);
      return undefined;
    }
    throw err;
  }
}

function challengeHeader(auth: McpHttpAuth, error?: string, scope?: string): string {
  const attrs: string[] = [];
  if (error !== undefined) attrs.push(`error="${error}"`);
  if (scope !== undefined) attrs.push(`scope="${scope}"`);
  attrs.push(`resource_metadata="${auth.resourceMetadataUrl}"`);
  return `Bearer ${attrs.join(', ')}`;
}

function respondChallenge(res: ServerResponse, status: number, message: string, challenge: string): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, {
    'content-type': 'application/json',
    'www-authenticate': challenge,
  });
  res.end(JSON.stringify({ error: message }));
}

function respondInsufficientScope(res: ServerResponse, auth: McpHttpAuth, requiredScope: string): void {
  respondChallenge(
    res,
    403,
    `This operation requires the "${requiredScope}" scope.`,
    challengeHeader(auth, 'insufficient_scope', requiredScope),
  );
}

/** The client identifier for the SDK's AuthInfo: OAuth `client_id` when the
 *  AS includes it, else `azp` (Keycloak / OIDC), else the subject. Purely
 *  informational on this server. */
function clientIdOf(claims: Record<string, unknown>): string {
  for (const key of ['client_id', 'azp', 'sub']) {
    const value = claims[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return '';
}

async function handleMcp(
  req: IncomingMessage,
  res: ServerResponse,
  cache: SchemaCache,
  transports: Map<string, StreamableHTTPServerTransport>,
  execution: McpExecution | undefined,
  maxBodyBytes: number,
  auth: McpHttpAuth | undefined,
  authCtx: McpAuthContext | undefined,
  provenance: boolean,
): Promise<void> {
  const sessionId = headerValue(req.headers['mcp-session-id']);

  // Existing session: reuse its transport (and the MCP server bound to it).
  // Note the caller has already authenticated this request (auth mode): a
  // session id never substitutes for a token — every request is verified.
  if (sessionId !== undefined) {
    const existing = transports.get(sessionId);
    if (existing === undefined) {
      respondError(res, 404, `Unknown MCP session: ${sessionId}`);
      return;
    }
    // A POST carries a JSON-RPC message body. Read it through the capped reader
    // here (rather than letting the SDK transport buffer the raw stream itself)
    // so an established session cannot stream an unbounded body — the
    // Content-Length short-circuit above only catches a *declared* size. GET
    // (the SSE stream) and DELETE (session teardown) carry no body, so they go
    // straight to the transport.
    if (req.method === 'POST') {
      let body: unknown;
      try {
        body = await readJsonBody(req, maxBodyBytes);
      } catch (err) {
        if (err instanceof HttpBodyError) {
          respondError(res, err.status, err.message);
          return;
        }
        throw err;
      }
      if (body === undefined) {
        respondError(res, 400, 'Bad Request: empty or invalid JSON body.');
        return;
      }
      if (auth !== undefined && authCtx !== undefined) {
        const missing = missingToolScope(body, auth, authCtx);
        if (missing !== undefined) {
          respondInsufficientScope(res, auth, missing);
          return;
        }
      }
      await existing.handleRequest(req, res, body);
      return;
    }
    await existing.handleRequest(req, res);
    return;
  }

  // No session id: this must be an initialize request that opens a new
  // session. The body is read once here so we can both classify it and
  // hand it to the transport (which would otherwise consume the stream).
  let body: unknown;
  try {
    body = await readJsonBody(req, maxBodyBytes);
  } catch (err) {
    if (err instanceof HttpBodyError) {
      respondError(res, err.status, err.message);
      return;
    }
    throw err;
  }
  if (!isInitializeRequest(body)) {
    respondError(
      res,
      400,
      'Bad Request: missing mcp-session-id header (no active session)',
    );
    return;
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true,
    onsessioninitialized: (sid) => {
      transports.set(sid, transport);
    },
  });
  transport.onclose = () => {
    if (transport.sessionId !== undefined) {
      transports.delete(transport.sessionId);
    }
  };

  const server = createMcpServer(
    cache,
    execution,
    auth === undefined ? undefined : { describe: auth.scopes.describe, execute: auth.scopes.execute },
    auth?.allowedRoles,
    provenance,
  );
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

/** The scope a `tools/call` message requires but the token lacks, or
 *  undefined when the request may proceed. Scope failures answer with an
 *  HTTP 403 `insufficient_scope` challenge (RFC 6750) so a client capable
 *  of scope upgrade can re-authorize; the dispatch layer inside the MCP
 *  server double-checks independently. Only `tools/call` is gated here:
 *  initialize / tools/list must work with any accepted token (the list is
 *  filtered per scope instead).
 *
 *  The body may be a JSON-RPC batch (an array) — the SDK transport still
 *  accepts them — so every message is scanned and the first `tools/call`
 *  the token cannot satisfy wins. Scanning the batch here (not just the
 *  single-object shape) keeps a batched execute call from slipping past the
 *  HTTP challenge. */
function missingToolScope(body: unknown, auth: McpHttpAuth, ctx: McpAuthContext): string | undefined {
  const messages = Array.isArray(body) ? body : [body];
  for (const message of messages) {
    if (typeof message !== 'object' || message === null) continue;
    const m = message as { method?: unknown; params?: { name?: unknown } };
    if (m.method !== 'tools/call') continue;
    const required = m.params?.name === 'call' ? auth.scopes.execute : auth.scopes.describe;
    if (!ctx.scopes.has(required)) return required;
  }
  return undefined;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

async function readJsonBody(req: IncomingMessage, maxBodyBytes: number): Promise<unknown> {
  // Reject a non-JSON media type up front (when one is declared). A missing
  // Content-Type is tolerated — some clients omit it on a JSON POST.
  const contentType = headerValue(req.headers['content-type']);
  if (contentType !== undefined && !/^application\/json\b/i.test(contentType)) {
    throw new HttpBodyError(415, 'Unsupported Media Type: expected application/json.');
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    // Enforce the cap while streaming so a chunked / Content-Length-less body
    // cannot grow the buffer past the limit. Throwing exits the async iterator
    // (which stops reading); the caller maps this to a 413 response.
    if (total > maxBodyBytes) {
      throw new HttpBodyError(413, 'Request body too large.');
    }
    chunks.push(buf);
  }
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.length === 0) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function respondError(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: message }));
}

function closeServer(httpServer: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    httpServer.close((err) => (err ? reject(err) : resolve()));
  });
}
