import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pkg from 'pg';
import { request as httpRequest } from 'node:http';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import {
  SchemaCache,
  startHttpServer,
  isLoopbackHost,
  type HttpServerHandle,
} from '../src/index.js';
import { buildRebindingGuard } from '../src/startHttpServer.js';

/** Send a raw HTTP request so we can set the Host / Origin headers freely
 *  (undici's fetch refuses to override Host). Resolves with the status code. */
function rawRequest(
  port: number,
  opts: { method?: string; path?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: opts.method ?? 'GET',
        path: opts.path ?? '/',
        headers: opts.headers,
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}
import {
  setupDatabase,
  type DatabaseHandle,
  MINIMAL_FIXTURE_SQL,
} from '@kozou/test-utils';

describe('isLoopbackHost', () => {
  it('recognises loopback hosts', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
  });

  it('rejects non-loopback hosts', () => {
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('192.168.1.10')).toBe(false);
    expect(isLoopbackHost('example.com')).toBe(false);
  });
});

describe('buildRebindingGuard', () => {
  it('always accepts loopback hostnames (port-agnostic) for a loopback bind', () => {
    const guard = buildRebindingGuard('127.0.0.1');
    expect([...guard.hostnames].sort()).toEqual(['127.0.0.1', '::1', 'localhost']);
    expect(guard.allowedOrigins).toBeUndefined();
  });

  it('adds the bound hostname for a specific non-loopback bind', () => {
    const guard = buildRebindingGuard('mcp.internal');
    expect(guard.hostnames.has('mcp.internal')).toBe(true);
    // Loopback names are still accepted.
    expect(guard.hostnames.has('localhost')).toBe(true);
  });

  it('keeps loopback hostnames for a bind-all address (still guards rebinding)', () => {
    // 0.0.0.0 cannot be enumerated, but loopback hostnames stay allowed so the
    // common (Docker-mapped) loopback access works while attacker hostnames are
    // still refused.
    expect([...buildRebindingGuard('0.0.0.0').hostnames].sort()).toEqual([
      '127.0.0.1',
      '::1',
      'localhost',
    ]);
    expect([...buildRebindingGuard('::').hostnames].sort()).toEqual(['127.0.0.1', '::1', 'localhost']);
  });

  it('adds allowedHosts hostnames and takes an exact allowedOrigins list', () => {
    const guard = buildRebindingGuard('0.0.0.0', {
      allowedHosts: ['mcp.example.com:3334'],
      allowedOrigins: ['https://app.example.com'],
    });
    expect(guard.hostnames.has('mcp.example.com')).toBe(true);
    expect([...(guard.allowedOrigins ?? [])]).toEqual(['https://app.example.com']);
  });
});

describe('startHttpServer routing (no database required)', () => {
  let handle: HttpServerHandle;
  let cache: SchemaCache;
  let baseUrl: string;

  beforeAll(async () => {
    // The routing assertions below never reach SchemaCache.get(), so a
    // connection string that is never dialed is sufficient.
    cache = new SchemaCache({ connection: 'postgres://invalid:5432/none' });
    handle = await startHttpServer(cache, { port: 0, host: '127.0.0.1' });
    baseUrl = `http://127.0.0.1:${handle.port}`;
  });

  afterAll(async () => {
    if (handle) await handle.close();
  });

  it('POST /admin/refresh invalidates the cache and returns ok', async () => {
    const spy = vi.spyOn(cache, 'invalidate');
    const res = await fetch(`${baseUrl}/admin/refresh`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('GET /admin/refresh is rejected (POST only)', async () => {
    const res = await fetch(`${baseUrl}/admin/refresh`, { method: 'GET' });
    expect(res.status).toBe(405);
  });

  it('returns 404 for an unknown path', async () => {
    const res = await fetch(`${baseUrl}/nope`);
    expect(res.status).toBe(404);
  });

  it('rejects a request whose Host header is not allowed (DNS-rebinding guard)', async () => {
    // A rebound page reaches the loopback port but still carries the
    // attacker-controlled hostname in the Host header. The guard runs before
    // routing, so even POST /admin/refresh is refused with 403.
    const status = await rawRequest(handle.port, {
      method: 'POST',
      path: '/admin/refresh',
      headers: { host: 'attacker.example:1234' },
    });
    expect(status).toBe(403);
  });

  it('rejects a request with a valid Host but a disallowed Origin', async () => {
    const status = await rawRequest(handle.port, {
      method: 'POST',
      path: '/admin/refresh',
      headers: { host: `127.0.0.1:${handle.port}`, origin: 'http://attacker.example' },
    });
    expect(status).toBe(403);
  });

  it('allows a request with a valid Host and no Origin (a non-browser client)', async () => {
    const status = await rawRequest(handle.port, {
      method: 'POST',
      path: '/admin/refresh',
      headers: { host: `127.0.0.1:${handle.port}` },
    });
    expect(status).toBe(200);
  });

  it('accepts a valid Host case-insensitively (hostnames are not case-sensitive)', async () => {
    const status = await rawRequest(handle.port, {
      method: 'POST',
      path: '/admin/refresh',
      headers: { host: `LOCALHOST:${handle.port}` },
    });
    expect(status).toBe(200);
  });

  it('rejects an MCP request without a session id that is not initialize', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {},
      }),
    });
    expect(res.status).toBe(400);
  });
});

describe('startHttpServer DNS-rebinding guard on a bind-all address', () => {
  let handle: HttpServerHandle;

  beforeAll(async () => {
    // Bound to 0.0.0.0 (the shipped `kozou dev` default inside a container).
    // The guard must still refuse an attacker Host while allowing loopback.
    const cache = new SchemaCache({ connection: 'postgres://invalid:5432/none' });
    handle = await startHttpServer(cache, { port: 0, host: '0.0.0.0' });
  });

  afterAll(async () => {
    if (handle) await handle.close();
  });

  it('refuses an attacker-controlled Host even when bound to 0.0.0.0', async () => {
    const status = await rawRequest(handle.port, {
      method: 'POST',
      path: '/admin/refresh',
      headers: { host: 'attacker.example:1234' },
    });
    expect(status).toBe(403);
  });

  it('still allows loopback access (the Docker-mapped client path)', async () => {
    const status = await rawRequest(handle.port, {
      method: 'POST',
      path: '/admin/refresh',
      headers: { host: `localhost:${handle.port}` },
    });
    expect(status).toBe(200);
  });
});

describe('startHttpServer request body limits', () => {
  let handle: HttpServerHandle;
  let cache: SchemaCache;
  let baseUrl: string;

  beforeAll(async () => {
    cache = new SchemaCache({ connection: 'postgres://invalid:5432/none' });
    // A tiny cap so a modest body trips the limit.
    handle = await startHttpServer(cache, { port: 0, host: '127.0.0.1', maxBodyBytes: 64 });
    baseUrl = `http://127.0.0.1:${handle.port}`;
  });

  afterAll(async () => {
    if (handle) await handle.close();
  });

  it('rejects an over-sized body with 413 (declared Content-Length)', async () => {
    const big = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'x',
      params: { pad: 'a'.repeat(200) },
    });
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: big,
    });
    expect(res.status).toBe(413);
  });

  it('rejects an over-sized body while streaming with 413', async () => {
    // A raw request whose body exceeds the cap; the streaming guard trips
    // regardless of how the size is framed on the wire.
    const status = await rawRequest(handle.port, {
      method: 'POST',
      path: '/mcp',
      headers: { host: `127.0.0.1:${handle.port}`, 'content-type': 'application/json' },
      body: 'x'.repeat(500),
    });
    expect(status).toBe(413);
  });

  it('rejects a non-JSON Content-Type with 415', async () => {
    const status = await rawRequest(handle.port, {
      method: 'POST',
      path: '/mcp',
      headers: { host: `127.0.0.1:${handle.port}`, 'content-type': 'text/plain' },
      body: 'hello',
    });
    expect(status).toBe(415);
  });
});

describe('startHttpServer existing-session body cap', () => {
  let handle: HttpServerHandle;
  let baseUrl: string;

  beforeAll(async () => {
    // The MCP handshake is transport-level (no SchemaCache.get), so an
    // un-dialed connection is enough to open a session. The cap is large enough
    // to admit the initialize body but small enough to trip on a modest POST.
    const cache = new SchemaCache({ connection: 'postgres://invalid:5432/none' });
    handle = await startHttpServer(cache, { port: 0, host: '127.0.0.1', maxBodyBytes: 4096 });
    baseUrl = `http://127.0.0.1:${handle.port}`;
  });

  afterAll(async () => {
    if (handle) await handle.close();
  });

  it('enforces the cap on an established session (chunked, no Content-Length) → 413', async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    const client = new Client({ name: 'kozou-test', version: '0.0.0' });
    try {
      await client.connect(transport);
      const sessionId = transport.sessionId;
      expect(sessionId).toBeTruthy();

      // A POST to the live session whose body exceeds the cap. The Content-
      // Length short-circuit and the streaming guard both target this; the
      // request must be refused before the SDK transport buffers it.
      const status = await rawRequest(handle.port, {
        method: 'POST',
        path: '/mcp',
        headers: {
          host: `127.0.0.1:${handle.port}`,
          'content-type': 'application/json',
          'mcp-session-id': sessionId as string,
        },
        body: 'x'.repeat(8000),
      });
      expect(status).toBe(413);
    } finally {
      await client.close();
    }
  });
});

describe('startHttpServer MCP over HTTP (generic fixture)', () => {
  let db: DatabaseHandle;
  let handle: HttpServerHandle;

  beforeAll(async () => {
    db = await setupDatabase();
    const client = new pkg.Client({ connectionString: db.connectionString });
    await client.connect();
    try {
      await client.query(`CREATE SCHEMA "${db.schema}"`);
      await client.query(`SET search_path TO "${db.schema}"`);
      await client.query(MINIMAL_FIXTURE_SQL);
    } finally {
      await client.end();
    }

    const cache = new SchemaCache({
      connection: db.connectionString,
      schemas: [db.schema],
      ttlMs: 60_000,
    });
    handle = await startHttpServer(cache, { port: 0, host: '127.0.0.1' });
  }, 120_000);

  afterAll(async () => {
    if (handle) await handle.close();
    if (db) await db.cleanup();
  });

  it('serves the MCP tool list + a list_tables call over HTTP', async () => {
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${handle.port}/mcp`),
    );
    const client = new Client({ name: 'kozou-test', version: '0.0.0' });
    try {
      await client.connect(transport);

      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name);
      expect(names).toContain('list_tables');
      expect(names).toContain('describe_table');

      const result = await client.callTool({
        name: 'list_tables',
        arguments: { schema: db.schema },
      });
      const content = result.content as Array<{ type: string; text: string }>;
      const payload = JSON.parse(content[0].text) as {
        tables: Array<{ qualifiedName: string }>;
      };
      const qualified = payload.tables.map((t) => t.qualifiedName).sort();
      expect(qualified).toEqual([`${db.schema}.authors`, `${db.schema}.books`]);
    } finally {
      await client.close();
    }
  });
});
