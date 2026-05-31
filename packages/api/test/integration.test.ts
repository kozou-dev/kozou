import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pkg from 'pg';
import { introspect } from '@kozou/introspect';
import { buildSchemaContext } from '@kozou/core';
import { setupDatabase, type DatabaseHandle, GENERIC_FIXTURE_SQL } from '@kozou/test-utils';
import { startApiServer, type ApiServerHandle, type Queryable } from '../src/index.js';

// End-to-end: introspect a real fixture DB, build the SchemaContext, start
// the REST server against a connection pool, and exercise the read path
// over real HTTP. This is the proof that the same query-builder /
// schema-lookup that the unit tests cover produces working SQL.

const ABSENT_UUID = '00000000-0000-0000-0000-000000000000';

type ListBody = {
  rows: Record<string, unknown>[];
  total: number;
  page: number;
  pageSize: number;
};

describe('@kozou/api integration (generic fixture)', () => {
  let db: DatabaseHandle;
  let pool: pkg.Pool;
  let server: ApiServerHandle;
  let base: string;
  let adaId: string;

  beforeAll(async () => {
    db = await setupDatabase();

    const client = new pkg.Client({ connectionString: db.connectionString });
    await client.connect();
    try {
      await client.query(`CREATE SCHEMA "${db.schema}"`);
      await client.query(`SET search_path TO "${db.schema}"`);
      await client.query(GENERIC_FIXTURE_SQL);
      const inserted = await client.query<{ id: string; display_name: string }>(
        `INSERT INTO authors (display_name) VALUES ($1), ($2), ($3) RETURNING id, display_name`,
        ['Ada Lovelace', 'Alan Turing', 'Grace Hopper'],
      );
      adaId = inserted.rows.find((r) => r.display_name === 'Ada Lovelace')!.id;
    } finally {
      await client.end();
    }

    const raw = await introspect({ connection: db.connectionString, schemas: [db.schema] });
    const schema = await buildSchemaContext({ raw });

    pool = new pkg.Pool({ connectionString: db.connectionString });
    const queryable: Queryable = {
      query: (text: string, values?: unknown[]) => pool.query(text, values),
    };
    server = await startApiServer({
      schema,
      db: queryable,
      host: '127.0.0.1',
      port: 0,
      version: '0.0.0-test',
    });
    base = `http://127.0.0.1:${server.port}`;
  }, 120_000);

  afterAll(async () => {
    if (server) await server.close();
    if (pool) await pool.end();
    if (db) await db.cleanup();
  });

  const getJson = async <T>(path: string): Promise<{ status: number; body: T }> => {
    const r = await fetch(`${base}${path}`);
    return { status: r.status, body: (await r.json()) as T };
  };

  it('GET / lists the introspected resources', async () => {
    const { status, body } = await getJson<{ resources: string[] }>('/');
    expect(status).toBe(200);
    expect(body.resources).toContain(`${db.schema}.authors`);
    expect(body.resources).toContain(`${db.schema}.vw_inventory_for_sale`);
  });

  it('lists all rows with an exact total', async () => {
    const { status, body } = await getJson<ListBody>('/authors');
    expect(status).toBe(200);
    expect(body.total).toBe(3);
    expect(body.rows).toHaveLength(3);
  });

  it('paginates with page + pageSize', async () => {
    const page1 = await getJson<ListBody>('/authors?pageSize=2');
    expect(page1.body.rows).toHaveLength(2);
    expect(page1.body.total).toBe(3);
    expect(page1.body.pageSize).toBe(2);

    const page2 = await getJson<ListBody>('/authors?pageSize=2&page=2');
    expect(page2.body.rows).toHaveLength(1);
  });

  it('sorts ascending and descending by a column', async () => {
    const asc = await getJson<{ rows: { display_name: string }[] }>('/authors?sort=display_name.asc');
    expect(asc.body.rows[0].display_name).toBe('Ada Lovelace');
    const desc = await getJson<{ rows: { display_name: string }[] }>('/authors?sort=display_name.desc');
    expect(desc.body.rows[0].display_name).toBe('Grace Hopper');
  });

  it('free-text searches text columns without erroring on uuid columns', async () => {
    const { status, body } = await getJson<{ rows: { display_name: string }[]; total: number }>(
      '/authors?search=ada',
    );
    expect(status).toBe(200);
    expect(body.total).toBe(1);
    expect(body.rows[0].display_name).toBe('Ada Lovelace');
  });

  it('fetches a single row by primary key', async () => {
    const { status, body } = await getJson<{ display_name: string }>(`/authors/${adaId}`);
    expect(status).toBe(200);
    expect(body.display_name).toBe('Ada Lovelace');
  });

  it('returns 404 for a missing row', async () => {
    const { status } = await getJson(`/authors/${ABSENT_UUID}`);
    expect(status).toBe(404);
  });

  it('serves a VIEW as a read-only list', async () => {
    const { status, body } = await getJson<ListBody>('/vw_inventory_for_sale');
    expect(status).toBe(200);
    expect(Array.isArray(body.rows)).toBe(true);
    expect(typeof body.total).toBe('number');
  });

  it('rejects an unknown filter column with 400', async () => {
    const { status } = await getJson('/authors?bogus=1');
    expect(status).toBe(400);
  });

  it('rejects a write method with 405 (writes land in Phase 2)', async () => {
    const r = await fetch(`${base}/authors`, { method: 'POST' });
    expect(r.status).toBe(405);
  });

  it('returns 404 for an unknown resource', async () => {
    const { status } = await getJson('/does_not_exist');
    expect(status).toBe(404);
  });
});
