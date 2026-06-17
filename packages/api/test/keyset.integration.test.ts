import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pkg from 'pg';
import { introspect } from '@kozou/introspect';
import { buildSchemaContext } from '@kozou/core';
import { setupDatabase, type DatabaseHandle } from '@kozou/test-utils';
import { startApiServer, type ApiServerHandle, type Queryable } from '../src/index.js';

// Keyset (cursor) pagination against a real PostgreSQL (issue #185). The proof
// is differential: walking the whole table page-by-page with `after` (following
// each response's `nextCursor`) must reproduce — exactly, no gaps or
// duplicates — the order a single large offset page returns. PostgreSQL defines
// the reference order (including NULL placement and the primary-key
// tiebreaker), so the keyset predicate is correct iff the two agree. Exercised
// across the default PK order, a custom mixed/nullable sort, and a composite
// primary key.

type Row = Record<string, unknown>;
type ListBody = {
  rows: Row[];
  total: number | null;
  page: number;
  pageSize: number;
  nextCursor: string | null;
  prevCursor: string | null;
};

describe('@kozou/api keyset pagination (real PostgreSQL, #185)', () => {
  let db: DatabaseHandle;
  let pool: pkg.Pool;
  let server: ApiServerHandle;
  let base: string;

  beforeAll(async () => {
    db = await setupDatabase();
    const client = new pkg.Client({ connectionString: db.connectionString });
    await client.connect();
    try {
      await client.query(`CREATE SCHEMA "${db.schema}"`);
      await client.query(`SET search_path TO "${db.schema}"`);
      // `score` is nullable with ties and NULLs, so the order needs the id
      // tiebreaker and exercises NULL placement under both sort directions.
      // `at` is `timestamp without time zone` with ties and sub-second precision
      // — the case that breaks a JS-Date/JSON cursor (UTC shift + precision loss)
      // but round-trips exactly through the text-cast cursor key.
      await client.query(`
        CREATE TABLE events (
          id integer PRIMARY KEY,
          score integer,
          label text NOT NULL,
          at timestamp NOT NULL
        );
        INSERT INTO events (id, score, label, at) VALUES
          (1, 10, 'a', '2020-01-01 08:30:00'), (2, 10, 'b', '2020-01-01 08:30:00'),
          (3, 5, 'c', '2020-01-02 12:00:00.123'), (4, NULL, 'd', '2020-01-03 00:00:00'),
          (5, 20, 'e', '2019-12-31 23:59:59.999'), (6, 5, 'f', '2020-01-02 12:00:00.123'),
          (7, NULL, 'g', '2020-06-15 06:00:00'), (8, 10, 'h', '2020-01-01 08:30:01'),
          (9, 1, 'i', '2021-01-01 00:00:00'), (10, 20, 'j', '2020-03-03 03:03:03'),
          (11, NULL, 'k', '2020-01-01 00:00:00'), (12, 7, 'l', '2020-02-02 02:02:02'),
          (13, 5, 'm', '2020-01-02 12:00:00.124');

        CREATE TABLE legs (
          route integer NOT NULL,
          seq integer NOT NULL,
          note text NOT NULL,
          PRIMARY KEY (route, seq)
        );
        INSERT INTO legs (route, seq, note) VALUES
          (1,1,'a'),(1,2,'b'),(1,3,'c'),(2,1,'d'),(2,2,'e'),
          (3,1,'f'),(3,2,'g'),(3,3,'h'),(3,4,'i');
      `);
    } finally {
      await client.end();
    }

    const raw = await introspect({ connection: db.connectionString, schemas: [db.schema] });
    const schema = await buildSchemaContext({ raw });
    pool = new pkg.Pool({ connectionString: db.connectionString });
    const queryable: Queryable = { query: (text, values) => pool.query(text, values) };
    server = await startApiServer({ schema, db: queryable, host: '127.0.0.1', port: 0 });
    base = `http://127.0.0.1:${server.port}`;
  }, 120_000);

  afterAll(async () => {
    if (server) await server.close();
    if (pool) await pool.end();
    if (db) await db.cleanup();
  });

  async function getList(query: string): Promise<ListBody> {
    const r = await fetch(`${base}${query}`);
    expect(r.status, query).toBe(200);
    return (await r.json()) as ListBody;
  }

  /** The reference order: one large offset page. */
  async function fullOrder(path: string, sort = ''): Promise<Row[]> {
    const qs = `${path}?pageSize=100${sort}`;
    return (await getList(qs)).rows;
  }

  /** Walk the whole relation forward via `after`, following `nextCursor`. */
  async function walkForward(path: string, pageSize: number, sort = ''): Promise<Row[]> {
    const collected: Row[] = [];
    let cursor: string | null = null;
    // A generous step cap so a bug (a cursor that never advances) fails loudly
    // instead of looping forever.
    for (let step = 0; step < 100; step++) {
      const qs = `${path}?pageSize=${pageSize}${sort}${cursor ? `&after=${cursor}` : ''}`;
      const body: ListBody = await getList(qs);
      collected.push(...body.rows);
      if (body.nextCursor === null) return collected;
      cursor = body.nextCursor;
    }
    throw new Error('walkForward did not terminate — cursor likely not advancing');
  }

  it('default PK order: forward keyset walk reproduces the full order with no gaps/dupes', async () => {
    const reference = await fullOrder('/events');
    const walked = await walkForward('/events', 4);
    expect(walked.map((r) => r.id)).toEqual(reference.map((r) => r.id));
    expect(walked).toHaveLength(13);
    expect(new Set(walked.map((r) => r.id)).size).toBe(13); // no duplicates
  });

  it('custom mixed/nullable sort (score desc, id asc): keyset matches the offset order', async () => {
    const sort = '&sort=score.desc';
    const reference = await fullOrder('/events', sort);
    const walked = await walkForward('/events', 3, sort);
    // Same rows in the same order PostgreSQL produced — NULLs included, with the
    // id tiebreaker, under NULLS FIRST for the DESC sort.
    expect(walked.map((r) => [r.score, r.id])).toEqual(reference.map((r) => [r.score, r.id]));
    expect(walked).toHaveLength(13);
  });

  it('nullable ASC sort (score asc, NULLS LAST): keyset matches the offset order', async () => {
    const sort = '&sort=score.asc';
    const reference = await fullOrder('/events', sort);
    const walked = await walkForward('/events', 5, sort);
    expect(walked.map((r) => [r.score, r.id])).toEqual(reference.map((r) => [r.score, r.id]));
  });

  it('timestamp sort (ties + sub-second): keyset matches offset, cursor round-trips losslessly', async () => {
    // `at` is timestamp-without-tz with ties (id 1/2, id 3/6) and millisecond
    // precision; a Date/JSON cursor would shift/round the boundary and mispage,
    // the text-cast cursor key does not.
    const sort = '&sort=at.desc';
    const reference = await fullOrder('/events', sort);
    const walked = await walkForward('/events', 3, sort);
    expect(walked.map((r) => [r.at, r.id])).toEqual(reference.map((r) => [r.at, r.id]));
    expect(walked).toHaveLength(13);
  });

  it('composite primary key: forward keyset walk reproduces the full order', async () => {
    const reference = await fullOrder('/legs');
    const walked = await walkForward('/legs', 2);
    expect(walked.map((r) => [r.route, r.seq])).toEqual(reference.map((r) => [r.route, r.seq]));
    expect(walked).toHaveLength(9);
  });

  it('before: prevCursor navigates back to the prior page', async () => {
    const reference = await fullOrder('/events');
    const page1 = await getList('/events?pageSize=4');
    expect(page1.rows.map((r) => r.id)).toEqual(reference.slice(0, 4).map((r) => r.id));
    expect(page1.prevCursor).toBeNull(); // initial page

    const page2 = await getList(`/events?pageSize=4&after=${page1.nextCursor}`);
    expect(page2.rows.map((r) => r.id)).toEqual(reference.slice(4, 8).map((r) => r.id));
    expect(page2.prevCursor).not.toBeNull();

    // Step back from page 2 — must land exactly on page 1's rows, in order.
    const back = await getList(`/events?pageSize=4&before=${page2.prevCursor}`);
    expect(back.rows.map((r) => r.id)).toEqual(page1.rows.map((r) => r.id));
  });

  it('rejects a cursor whose order does not match the current sort (400)', async () => {
    const page = await getList('/events?pageSize=4'); // cursor for the default id order
    const mismatched = await fetch(`${base}/events?sort=score.desc&after=${page.nextCursor}`);
    expect(mismatched.status).toBe(400);
  });

  it('rejects after + before together (400)', async () => {
    const page = await getList('/events?pageSize=4');
    const both = await fetch(`${base}/events?after=${page.nextCursor}&before=${page.nextCursor}`);
    expect(both.status).toBe(400);
  });
});
