import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pkg from 'pg';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { setupDatabase, type DatabaseHandle } from './setup.js';
import { SchemaCache } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const nimartSql = readFileSync(
  resolve(here, '../../../examples/nimart/migrations/0001_init.sql'),
  'utf8',
);

describe('SchemaCache (nimart fixture)', () => {
  let db: DatabaseHandle;

  beforeAll(async () => {
    db = await setupDatabase();
    const client = new pkg.Client({ connectionString: db.connectionString });
    await client.connect();
    try {
      await client.query(`CREATE SCHEMA "${db.schema}"`);
      await client.query(`SET search_path TO "${db.schema}"`);
      await client.query(nimartSql);
    } finally {
      await client.end();
    }
  }, 120_000);

  afterAll(async () => {
    if (db) await db.cleanup();
  });

  it('TTL 内は同 instance を返す', async () => {
    const cache = new SchemaCache({
      connection: db.connectionString,
      schemas: [db.schema],
      ttlMs: 60_000,
    });
    const ctx1 = await cache.get();
    const ctx2 = await cache.get();
    expect(ctx1).toBe(ctx2);
  });

  it('invalidate() で次回 get は新 instance', async () => {
    const cache = new SchemaCache({
      connection: db.connectionString,
      schemas: [db.schema],
      ttlMs: 60_000,
    });
    const ctx1 = await cache.get();
    cache.invalidate();
    const ctx2 = await cache.get();
    expect(ctx1).not.toBe(ctx2);
    expect(ctx2.tables.length).toBe(ctx1.tables.length);
  });

  it('TTL 0 で次回 get は即 expire', async () => {
    const cache = new SchemaCache({
      connection: db.connectionString,
      schemas: [db.schema],
      ttlMs: 0,
    });
    const ctx1 = await cache.get();
    const ctx2 = await cache.get();
    expect(ctx1).not.toBe(ctx2);
  });

  it('並行 get() で inflight 共有', async () => {
    const cache = new SchemaCache({
      connection: db.connectionString,
      schemas: [db.schema],
      ttlMs: 60_000,
    });
    const [ctx1, ctx2, ctx3] = await Promise.all([cache.get(), cache.get(), cache.get()]);
    expect(ctx1).toBe(ctx2);
    expect(ctx2).toBe(ctx3);
  });
});
