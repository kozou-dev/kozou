import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pkg from 'pg';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import {
  SchemaCache,
  startHttpServer,
  isLoopbackHost,
  type HttpServerHandle,
} from '../src/index.js';
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
