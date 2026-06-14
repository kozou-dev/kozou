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
};

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

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1']);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
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

  const httpServer = createServer((req, res) => {
    handleRequest(req, res, cache, mcpPath, transports, opts.execution).catch((err) => {
      respondError(res, 500, err instanceof Error ? err.message : String(err));
    });
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
): Promise<void> {
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
    await handleMcp(req, res, cache, transports, execution);
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
): Promise<void> {
  const sessionId = headerValue(req.headers['mcp-session-id']);

  // Existing session: reuse its transport (and the MCP server bound to it).
  if (sessionId !== undefined) {
    const existing = transports.get(sessionId);
    if (existing === undefined) {
      respondError(res, 404, `Unknown MCP session: ${sessionId}`);
      return;
    }
    await existing.handleRequest(req, res);
    return;
  }

  // No session id: this must be an initialize request that opens a new
  // session. The body is read once here so we can both classify it and
  // hand it to the transport (which would otherwise consume the stream).
  const body = await readJsonBody(req);
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

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
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
