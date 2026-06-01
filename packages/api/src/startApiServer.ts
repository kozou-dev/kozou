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

import { errorBody, KozouApiError } from './errors.js';
import {
  handleApiRequest,
  type ApiHandlerDeps,
  type ApiHttpRequest,
  type Queryable,
} from './handler.js';
import { buildResourceLookup } from './schema-lookup.js';
import { buildOpenApiDocument } from './openapi.js';
import { quoteIdent } from './ident.js';
import { createAuthenticator, type AuthConfig, type Authenticator } from './auth.js';

/** A pooled client: a Queryable that can be returned to its pool. A
 *  node-postgres `PoolClient` satisfies this. */
export type PoolClient = Queryable & { release(err?: boolean | Error): void };

/** A connection pool able to hand out dedicated clients. A `pg.Pool` fits. */
export type ConnectionPool = { connect(): Promise<PoolClient> };

export type StartApiServerOptions = {
  /** Introspected schema that drives routing + the identifier allowlist. */
  schema: SchemaContext;
  /** Open connection (a `pg.Pool` is the expected caller-owned value). */
  db: Queryable;
  /** Required when `auth` is set: source of dedicated clients for the
   *  per-request transaction that carries the role + claims. A `pg.Pool` fits. */
  pool?: ConnectionPool;
  /** Opt-in JWT verification + RLS enforcement. Omit for zero-auth behavior. */
  auth?: AuthConfig;
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

function nonLoopbackWarning(host: string, prefix: string, authed: boolean): string {
  if (authed) {
    return (
      `${prefix} NOTE: REST API bound to non-loopback host "${host}".\n` +
      `${prefix} JWT auth is enabled; terminate TLS in front of it so tokens\n` +
      `${prefix} are never sent in clear text.\n`
    );
  }
  return (
    `${prefix} WARNING: REST API bound to non-loopback host "${host}".\n` +
    `${prefix} This API has NO authentication configured (Kozou v0.1 spec §18.5).\n` +
    `${prefix} Anyone who can reach ${host} can read and write this database.\n` +
    `${prefix} Bind to 127.0.0.1 (the default) or configure JWT auth.\n`
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

async function buildHttpRequest(req: IncomingMessage): Promise<ApiHttpRequest> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const segments = url.pathname
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => safeDecode(s));
  const body = await readJsonBody(req);
  return {
    method: req.method ?? 'GET',
    segments,
    query: url.searchParams,
    body,
    headers: req.headers,
  };
}

async function dispatch(
  deps: ApiHandlerDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const result = await handleApiRequest(deps, await buildHttpRequest(req));
  respondJson(res, result.status, result.body);
}

/**
 * Authenticated dispatch: verify the JWT, then run the request inside a
 * transaction on a dedicated client under `SET LOCAL ROLE` with the claims
 * published so the database's row-level-security policies apply.
 */
async function dispatchAuthed(
  base: ApiHandlerDeps,
  authenticator: Authenticator,
  pool: ConnectionPool,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let auth;
  try {
    auth = await authenticator.authenticate(singleHeader(req.headers, 'authorization'));
  } catch (err) {
    // Reject before acquiring a connection (no leak on 401 / 403).
    respondError(res, err);
    return;
  }

  const httpReq = await buildHttpRequest(req);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      // Role is an identifier (no bound-parameter form); quote it. The role is
      // additionally constrained by the auth allowlist.
      await client.query(`SET LOCAL ROLE ${quoteIdent(auth.role)}`);
    } catch {
      throw new Error('Could not assume the requested role.');
    }
    // Claims are a value: bound parameter, never interpolated into SQL.
    await client.query('SELECT set_config($1, $2, true)', [
      authenticator.claimsGuc,
      JSON.stringify(auth.claims),
    ]);
    // The client is a Queryable; routing runs every query on it, inside this
    // transaction, so the role + claims apply.
    const deps: ApiHandlerDeps = { ...base, db: client };
    const result = await handleApiRequest(deps, httpReq);
    await client.query('COMMIT');
    respondJson(res, result.status, result.body);
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The connection may already be in a failed state; nothing to do.
    }
    respondError(res, err);
  } finally {
    client.release();
  }
}

function singleHeader(headers: IncomingMessage['headers'], name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function respondError(res: ServerResponse, err: unknown): void {
  if (err instanceof KozouApiError) {
    respondJson(res, err.status, errorBody(err.code, err.message));
    return;
  }
  // Never expose internal error detail (which can carry stack or database
  // information) to the client: log it server-side, return a generic message.
  const detail = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[@kozou/api] request failed: ${detail}\n`);
  respondJson(res, 500, errorBody('internal', 'Internal server error.'));
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

  const authenticator = opts.auth ? createAuthenticator(opts.auth) : undefined;
  if (authenticator !== undefined && opts.pool === undefined) {
    throw new Error(
      `${prefix} auth requires a "pool" (e.g. a pg.Pool) to run each request under SET LOCAL ROLE.`,
    );
  }

  if (!isLoopbackHost(host)) {
    process.stderr.write(nonLoopbackWarning(host, prefix, authenticator !== undefined));
  }

  const base: ApiHandlerDeps = {
    db: opts.db,
    lookup: buildResourceLookup(opts.schema),
    version: opts.version,
    openapi: buildOpenApiDocument(opts.schema, { version: opts.version }),
  };

  const pool = opts.pool;
  const listener =
    authenticator !== undefined && pool !== undefined
      ? (req: IncomingMessage, res: ServerResponse): void => {
          dispatchAuthed(base, authenticator, pool, req, res).catch((err: unknown) =>
            respondError(res, err),
          );
        }
      : createApiRequestListener(base);
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
