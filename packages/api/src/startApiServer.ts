// node:http wiring for the Kozou REST layer. Mirrors @kozou/mcp's
// startHttpServer: a thin request listener over the framework-agnostic
// handler, bound to loopback by default with a loud warning when bound to
// a non-loopback host (Kozou v0.1 spec §18.5 — the v0.2 API has no auth).

import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';

import type { SchemaContext } from '@kozou/core';

import { errorBody } from './errors.js';
import { handleApiRequest, type ApiHandlerDeps, type Queryable } from './handler.js';
import { buildResourceLookup } from './schema-lookup.js';
import { buildOpenApiDocument } from './openapi.js';

export type StartApiServerOptions = {
  /** Introspected schema that drives routing + the identifier allowlist. */
  schema: SchemaContext;
  /** Open connection (a `pg.Pool` is the expected caller-owned value). */
  db: Queryable;
  /** TCP port to listen on. Default: 3335 (3333 = UI, 3334 = MCP HTTP). */
  port?: number;
  /** Host/interface to bind. Default: 127.0.0.1 (loopback only). */
  host?: string;
  /** Version string advertised in `GET /`. */
  version?: string;
  /** Prefix used in stderr log lines. Default: '[@kozou/api]'. */
  logPrefix?: string;
};

export type ApiServerHandle = {
  /** The actual bound port (resolves an ephemeral `0` to the real port). */
  port: number;
  /** The host the server is bound to. */
  host: string;
  /** Stop accepting connections and resolve once the server has closed. */
  close: () => Promise<void>;
};

const DEFAULT_PORT = 3335;
const DEFAULT_HOST = '127.0.0.1';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1']);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

function nonLoopbackWarning(host: string, prefix: string): string {
  return (
    `${prefix} WARNING: REST API bound to non-loopback host "${host}".\n` +
    `${prefix} The v0.2 API has NO authentication (Kozou v0.1 spec §18.5).\n` +
    `${prefix} Anyone who can reach ${host} can read and (in later phases)\n` +
    `${prefix} write this database. Bind to 127.0.0.1 (the default) unless\n` +
    `${prefix} you have a trusted network and an external auth layer.\n`
  );
}

/**
 * Build a node:http request listener over the framework-agnostic handler.
 * Exposed separately so it can be mounted by an embedding server or driven
 * directly in tests.
 */
export function createApiRequestListener(
  deps: ApiHandlerDeps,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    dispatch(deps, req, res).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      respondJson(res, 500, errorBody('internal', message));
    });
  };
}

async function dispatch(
  deps: ApiHandlerDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const segments = url.pathname
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => safeDecode(s));
  const body = await readJsonBody(req);
  const result = await handleApiRequest(deps, {
    method: req.method ?? 'GET',
    segments,
    query: url.searchParams,
    body,
  });
  respondJson(res, result.status, result.body);
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

/**
 * Start the REST API over node:http, bound to the given schema + db.
 * Resolves once the server is listening.
 */
export async function startApiServer(opts: StartApiServerOptions): Promise<ApiServerHandle> {
  const prefix = opts.logPrefix ?? '[@kozou/api]';
  const host = opts.host ?? DEFAULT_HOST;
  const port = opts.port ?? DEFAULT_PORT;

  if (!isLoopbackHost(host)) {
    process.stderr.write(nonLoopbackWarning(host, prefix));
  }

  const listener = createApiRequestListener({
    db: opts.db,
    lookup: buildResourceLookup(opts.schema),
    version: opts.version,
    openapi: buildOpenApiDocument(opts.schema, { version: opts.version }),
  });
  const httpServer = createServer(listener);

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    httpServer.once('error', onError);
    httpServer.listen(port, host, () => {
      httpServer.removeListener('error', onError);
      resolve();
    });
  });

  const boundPort = (httpServer.address() as AddressInfo).port;
  process.stderr.write(`${prefix} REST API listening on http://${host}:${boundPort}\n`);

  return {
    port: boundPort,
    host,
    close: () => closeServer(httpServer),
  };
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function respondJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function closeServer(httpServer: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    httpServer.close((err) => (err ? reject(err) : resolve()));
  });
}
