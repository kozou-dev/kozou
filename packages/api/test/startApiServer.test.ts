import { describe, it, expect, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  startApiServer,
  createApiRequestListener,
  isLoopbackHost,
  type ApiServerHandle,
} from '../src/index.js';
import { buildResourceLookup } from '../src/schema-lookup.js';
import { schemaOf, col, recordingDb } from './helpers.js';

const schema = schemaOf([
  { name: 'authors', columns: [col('id', 'uuid'), col('display_name', 'text')], primaryKey: ['id'] },
]);

describe('isLoopbackHost', () => {
  it('recognises loopback and rejects non-loopback hosts', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('10.0.0.5')).toBe(false);
  });
});

describe('startApiServer over real HTTP', () => {
  let server: ApiServerHandle | undefined;

  afterEach(async () => {
    if (server) {
      await server.close();
      server = undefined;
    }
  });

  it('serves GET / and a list query (count + data) against a fake db', async () => {
    const { db } = recordingDb((text) =>
      text.includes('count(*)') ? { rows: [{ total: 1 }], rowCount: 1 } : { rows: [{ id: 'x' }], rowCount: 1 },
    );
    server = await startApiServer({
      schema,
      db,
      host: '127.0.0.1',
      port: 0,
      version: '0.0.0-test',
      logPrefix: '[test]',
    });
    const base = `http://127.0.0.1:${server.port}`;

    const root = await fetch(`${base}/`);
    expect(root.status).toBe(200);
    expect(((await root.json()) as { resources: string[] }).resources).toEqual(['public.authors']);

    const list = await fetch(`${base}/authors?pageSize=5`);
    expect(list.status).toBe(200);
    expect((await list.json()) as unknown).toEqual({
      rows: [{ id: 'x' }],
      total: 1,
      page: 1,
      pageSize: 5,
    });

    const missing = await fetch(`${base}/nope`);
    expect(missing.status).toBe(404);
  });

  it('warns but still binds when given a non-loopback host', async () => {
    const { db } = recordingDb(() => ({ rows: [], rowCount: 0 }));
    server = await startApiServer({ schema, db, host: '0.0.0.0', port: 0 });
    expect(server.host).toBe('0.0.0.0');
    expect(server.port).toBeGreaterThan(0);
  });
});

describe('createApiRequestListener', () => {
  it('falls back to the raw path segment when percent-decoding fails', async () => {
    const { db } = recordingDb(() => ({ rows: [], rowCount: 0 }));
    const listener = createApiRequestListener({ db, lookup: buildResourceLookup(schemaOf([])) });

    const result = await driveListener(listener, '/%E0%A4%A');
    expect(result.status).toBe(404); // malformed segment -> raw -> unknown resource
  });
});

/** Drive the listener with a minimal fake req/res pair and resolve on end(). */
function driveListener(
  listener: (req: IncomingMessage, res: ServerResponse) => void,
  url: string,
  method = 'GET',
): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    let status = 0;
    let headersSent = false;
    const res = {
      get headersSent() {
        return headersSent;
      },
      writeHead(s: number) {
        status = s;
        headersSent = true;
        return res as unknown as ServerResponse;
      },
      end(body?: string) {
        resolve({ status, body: body ?? '' });
      },
    } as unknown as ServerResponse;
    const req = { url, method } as IncomingMessage;
    listener(req, res);
  });
}
