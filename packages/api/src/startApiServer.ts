// node:http wiring for the Kozou REST layer. Mirrors @kozou/mcp's
// startHttpServer: a thin request listener over the framework-agnostic
// handler, bound to loopback by default with a loud warning when bound to
// a non-loopback host (the v0.2 API has no auth).

import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';

import { runInRoleTransaction } from '@kozou/core';
import type { ConnectionPool, SchemaContext } from '@kozou/core';

import {
  badRequest,
  errorBody,
  KozouApiError,
  mapDatabaseError,
  payloadTooLarge,
  unsupportedMediaType,
} from './errors.js';
import {
  handleApiRequest,
  type ApiHandlerDeps,
  type ApiHttpRequest,
  type Queryable,
} from './handler.js';
import { buildResourceLookup } from './schema-lookup.js';
import { buildFunctionLookup } from './rpc.js';
import { buildOpenApiDocument } from './openapi.js';
import { createAuthenticator, type AuthConfig, type Authenticator } from './auth.js';

// The pooled-client / connection-pool abstraction now lives in @kozou/core
// alongside the shared role-transaction envelope; re-export it so this
// package's consumers keep importing it from here.
export type { PoolClient, ConnectionPool } from '@kozou/core';

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
  /** Maximum accepted request body size in bytes. A body whose Content-Length
   *  exceeds this, or that streams past it, is rejected with 413; bounds the
   *  memory a single request can buffer. Default: 4 MiB. */
  maxBodyBytes?: number;
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
const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024; // 4 MiB (write payloads / RPC args)

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
    `${prefix} This API has NO authentication configured.\n` +
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
  maxBodyBytes: number = DEFAULT_MAX_BODY_BYTES,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    // Same sanitizer as the authenticated path: log the detail server-side,
    // never return raw error text in the body.
    dispatch(deps, req, res, maxBodyBytes).catch((err: unknown) => respondError(res, err));
  };
}

async function buildHttpRequest(
  req: IncomingMessage,
  maxBodyBytes: number,
): Promise<ApiHttpRequest> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const segments = url.pathname
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => safeDecode(s));
  const body = await readJsonBody(req, maxBodyBytes);
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
  maxBodyBytes: number,
): Promise<void> {
  const result = await handleApiRequest(deps, await buildHttpRequest(req, maxBodyBytes));
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
  maxBodyBytes: number,
): Promise<void> {
  let auth;
  try {
    auth = await authenticator.authenticate(singleHeader(req.headers, 'authorization'));
  } catch (err) {
    // Reject before acquiring a connection (no leak on 401 / 403).
    respondError(res, err);
    return;
  }

  const httpReq = await buildHttpRequest(req, maxBodyBytes);
  try {
    // Run the request inside the shared role-transaction envelope: the role is
    // assumed and the claims are published, then routing runs every query on
    // the dedicated client so the role + the database's row-level-security
    // policies apply. A GET only ever reads, so its envelope is opened READ
    // ONLY: the database then refuses any write for the request regardless of
    // the role's grants (a SELECT that reaches a volatile function or a
    // writable view cannot mutate). Every write method routes to a read/write
    // transaction.
    const readOnly = (req.method ?? 'GET').toUpperCase() === 'GET';
    const result = await runInRoleTransaction(
      pool,
      { role: auth.role, claimsGuc: authenticator.claimsGuc, claims: auth.claims, readOnly },
      (client) => handleApiRequest({ ...base, db: client }, httpReq),
    );
    respondJson(res, result.status, result.body);
  } catch (err) {
    respondError(res, err);
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
  // Same SQLSTATE contract as the request handler. This path sees database
  // errors raised outside routing — notably DEFERRABLE constraints, which
  // fire at COMMIT — and they must map to the same documented statuses.
  const mapped = mapDatabaseError(err);
  if (mapped !== null) {
    respondJson(res, mapped.status, errorBody(mapped.code, mapped.message));
    return;
  }
  respondJson(res, 500, errorBody('internal', 'Internal server error.'));
}

async function readJsonBody(req: IncomingMessage, maxBodyBytes: number): Promise<unknown> {
  // Reject an over-large body before buffering when the client declares its
  // size, so a huge declared payload never reaches memory.
  const declared = Number(singleHeader(req.headers, 'content-length'));
  if (Number.isFinite(declared) && declared > maxBodyBytes) {
    throw payloadTooLarge('Request body too large.');
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    // Enforce the cap while streaming too, so a chunked / Content-Length-less
    // body cannot grow the buffer past the limit.
    if (total > maxBodyBytes) {
      throw payloadTooLarge('Request body too large.');
    }
    chunks.push(buf);
  }
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString('utf8');
  // An empty or whitespace-only body is an absent body (a no-argument RPC call
  // or an all-default write), not a parse error.
  if (raw.trim().length === 0) return undefined;
  // A non-empty body must be JSON: reject a declared non-JSON media type with
  // 415 (a missing Content-Type is tolerated — some clients omit it).
  const contentType = singleHeader(req.headers, 'content-type');
  if (contentType !== undefined && !/^application\/json\b/i.test(contentType)) {
    throw unsupportedMediaType('Unsupported Media Type: expected application/json.');
  }
  try {
    return JSON.parse(raw);
  } catch {
    // A non-empty body that is not valid JSON is a client error: reject it up
    // front (#145). Previously it was swallowed into `undefined`, which the RPC
    // handler treats as an empty argument set — silently running a
    // no-argument/all-default function. (A table write already rejected an
    // absent body, so for writes this just turns it into a clearer, earlier
    // 400.)
    throw badRequest('Request body is not valid JSON.');
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
    functions: buildFunctionLookup(opts.schema),
    version: opts.version,
    openapi: buildOpenApiDocument(opts.schema, { version: opts.version }),
    logPrefix: prefix,
  };

  const pool = opts.pool;
  // The READ ONLY read guarantee (a GET cannot commit a write) is part of the
  // authenticated role-transaction envelope, which always runs each request on
  // a dedicated pooled client. The unauthenticated path keeps its prior direct
  // dispatch on the caller's `db` (autocommit): it is loopback-only by default
  // and enforces no per-request identity, and routing its reads through `pool`
  // would silently change the executor's authority when `db` and `pool` differ.
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const listener =
    authenticator !== undefined && pool !== undefined
      ? (req: IncomingMessage, res: ServerResponse): void => {
          dispatchAuthed(base, authenticator, pool, req, res, maxBodyBytes).catch((err: unknown) =>
            respondError(res, err),
          );
        }
      : createApiRequestListener(base, maxBodyBytes);
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
