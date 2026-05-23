import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pkg from 'pg';
import { setupDatabase, type DatabaseHandle } from './setup.js';
import { SchemaCache } from '../src/index.js';

// Minimal inline fixture for cache-behaviour tests. The Nimart sample that
// previously backed this suite is private dogfooding material and now lives
// in kozou-planning/private/.
const FIXTURE_SQL = `
CREATE TABLE authors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name text NOT NULL
);
COMMENT ON TABLE authors IS 'Authors of books.';

CREATE TABLE books (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id uuid NOT NULL REFERENCES authors(id),
  title text NOT NULL
);
COMMENT ON TABLE books IS 'Books authored by an author.';
`;

describe('SchemaCache (generic fixture)', () => {
  let db: DatabaseHandle;

  beforeAll(async () => {
    db = await setupDatabase();
    const client = new pkg.Client({ connectionString: db.connectionString });
    await client.connect();
    try {
      await client.query(`CREATE SCHEMA "${db.schema}"`);
      await client.query(`SET search_path TO "${db.schema}"`);
      await client.query(FIXTURE_SQL);
    } finally {
      await client.end();
    }
  }, 120_000);

  afterAll(async () => {
    if (db) await db.cleanup();
  });

  it('returns the same instance within the TTL', async () => {
    const cache = new SchemaCache({
      connection: db.connectionString,
      schemas: [db.schema],
      ttlMs: 60_000,
    });
    const ctx1 = await cache.get();
    const ctx2 = await cache.get();
    expect(ctx1).toBe(ctx2);
  });

  it('invalidate() forces the next get to return a new instance', async () => {
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

  it('TTL = 0 expires immediately on the next get', async () => {
    const cache = new SchemaCache({
      connection: db.connectionString,
      schemas: [db.schema],
      ttlMs: 0,
    });
    const ctx1 = await cache.get();
    const ctx2 = await cache.get();
    expect(ctx1).not.toBe(ctx2);
  });

  it('concurrent get() calls share the in-flight promise', async () => {
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
