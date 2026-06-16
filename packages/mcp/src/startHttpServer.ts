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
//   - MCP HTTP ships with **no authentication**, so the
//     server binds to localhost by default and prints a loud warning when
//     bound to a non-loopback host. By default the tools only expose schema
//     metadata (no SQL execution, no data access), which bounds the blast
//     radius. When the operator enables the `call` execution tool the blast
//     radius is no longer bounded to metadata — the warning escalates
//     accordingly — so execution + a non-loopback bind must be avoided unless
//     an external auth/proxy layer is in front.

import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import { createMcpServer } from './server.js';
import type { SchemaCache } from './schemaCache.js';
import type { McpExecution } from './execution.js';

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
  /** Override the set of `Host` header values accepted by the DNS-rebinding
   *  guard (host:port form, e.g. `mcp.internal:3334`). When omitted, a loopback
   *  bind accepts the loopback names on the bound port and a specific
   *  non-loopback bind accepts that host:port; a bind-all address (0.0.0.0 / ::)
   *  cannot be enumerated, so pass this to enable the guard there. */
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
  const stripped = value.startsWith('[')
    ? (() => {
        const end = value.indexOf(']');
        return end === -1 ? value : value.slice(1, end);
      })()
    : (() => {
        const colon = value.indexOf(':');
        return colon === -1 ? value : value.slice(0, colon);
      })();
  return stripped.toLowerCase();
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

/** Returns a rejection reason when the request's Host/Origin is not allowed by
 *  the guard, or null when the request may proceed. The Host header must be
 *  present and its hostname allowed. A *present* Origin must be allowed too
 *  (exact match when `allowedOrigins` is set, else its hostname must be
 *  allowed); a missing Origin — the usual non-browser MCP client — is fine. */
function validateRebindingHeaders(req: IncomingMessage, guard: RebindingGuard): string | null {
  const host = headerValue(req.headers.host);
  if (host === undefined || !guard.hostnames.has(hostnameOf(host))) {
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

  if (!isLoopbackHost(host)) {
    process.stderr.write(nonLoopbackWarning(host, prefix, opts.execution?.role));
  }

  // Active MCP sessions, keyed by the transport-issued session id.
  const transports = new Map<string, StreamableHTTPServerTransport>();

  // The DNS-rebinding guard is hostname-based and known up front; build it here
  // so the request handler (which only runs after listen()) closes over it.
  const guard = buildRebindingGuard(host, opts);

  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  const httpServer = createServer((req, res) => {
    handleRequest(req, res, cache, mcpPath, transports, opts.execution, guard, maxBodyBytes).catch(
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
  process.stderr.write(
    `${prefix} MCP HTTP listening on http://${host}:${boundPort}` +
      ` (MCP: ${mcpPath}, refresh: POST ${REFRESH_PATH})\n`,
  );
  process.stderr.write(
    `${prefix} DNS-rebinding guard: accepting Host names ${[...guard.hostnames].join(', ')}` +
      ` (set allowedHosts to add more)\n`,
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

  if (url.pathname === REFRESH_PATH) {
    if (req.method !== 'POST') {
      respondError(res, 405, 'Method Not Allowed: use POST /admin/refresh');
      return;
    }
    cache.invalidate();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (url.pathname === mcpPath) {
    await handleMcp(req, res, cache, transports, execution, maxBodyBytes);
    return;
  }

  respondError(res, 404, `Not Found: ${url.pathname}`);
}

async function handleMcp(
  req: IncomingMessage,
  res: ServerResponse,
  cache: SchemaCache,
  transports: Map<string, StreamableHTTPServerTransport>,
  execution: McpExecution | undefined,
  maxBodyBytes: number,
): Promise<void> {
  const sessionId = headerValue(req.headers['mcp-session-id']);

  // Existing session: reuse its transport (and the MCP server bound to it).
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

  const server = createMcpServer(cache, execution);
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
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
