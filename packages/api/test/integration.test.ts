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

// Fixed UUIDs for the composite-primary-key fixture (order_lines).
const ORDER_A = '11111111-1111-1111-1111-111111111111';
const ORDER_B = '22222222-2222-2222-2222-222222222222';

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
  let inventoryItemId: string;

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

      // A forward to-one chain rooted at Ada: author <- book <- edition <- item.
      const book = await client.query<{ id: string }>(
        `INSERT INTO books (author_id, title) VALUES ($1, $2) RETURNING id`,
        [adaId, 'Notes on the Analytical Engine'],
      );
      const edition = await client.query<{ id: string }>(
        `INSERT INTO editions (book_id, isbn) VALUES ($1, $2) RETURNING id`,
        [book.rows[0].id, '978-0-00-000000-1'],
      );
      const item = await client.query<{ id: string }>(
        `INSERT INTO inventory_items (edition_id, status, selling_price, visibility)
         VALUES ($1, 'for_sale', 42.50, 'public') RETURNING id`,
        [edition.rows[0].id],
      );
      inventoryItemId = item.rows[0].id;

      // A composite-primary-key table for the item-by-id (§3) tests.
      await client.query(
        `CREATE TABLE order_lines (
           order_id uuid NOT NULL,
           line_no integer NOT NULL,
           qty integer NOT NULL,
           PRIMARY KEY (order_id, line_no)
         )`,
      );
      await client.query(
        `INSERT INTO order_lines (order_id, line_no, qty)
         VALUES ($1, 1, 10), ($1, 2, 20), ($2, 1, 5)`,
        [ORDER_A, ORDER_B],
      );

      // A real column for the float range-overflow filter check (§4 / #81).
      await client.query(
        `CREATE TABLE float_samples (id integer PRIMARY KEY, approx real NOT NULL)`,
      );
      await client.query(`INSERT INTO float_samples (id, approx) VALUES (1, 1.5)`);
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

  // --- Horizontal filter operators (Kozou v1.0 spec §4) --------------------

  const q = (col: string, expr: string): string =>
    `/authors?${col}=${encodeURIComponent(expr)}`;

  it('eq (and the bare-value shorthand) matches one row', async () => {
    const op = await getJson<ListBody>(q('display_name', 'eq.Ada Lovelace'));
    expect(op.body.total).toBe(1);
    expect(op.body.rows[0].display_name).toBe('Ada Lovelace');
    // Bare value (no operator prefix) means eq — backward compatible.
    const bare = await getJson<ListBody>(q('display_name', 'Ada Lovelace'));
    expect(bare.body.total).toBe(1);
  });

  it('neq excludes the matching row', async () => {
    const { body } = await getJson<ListBody>(q('display_name', 'neq.Ada Lovelace'));
    expect(body.total).toBe(2);
    expect(body.rows.every((r) => r.display_name !== 'Ada Lovelace')).toBe(true);
  });

  it('ilike is case-insensitive and like is case-sensitive (with `*` wildcards)', async () => {
    const ilike = await getJson<ListBody>(q('display_name', 'ilike.*TURING*'));
    expect(ilike.body.total).toBe(1);
    expect(ilike.body.rows[0].display_name).toBe('Alan Turing');
    // Same pattern, wrong case, case-sensitive LIKE -> no match.
    const like = await getJson<ListBody>(q('display_name', 'like.*TURING*'));
    expect(like.body.total).toBe(0);
    const likeHit = await getJson<ListBody>(q('display_name', 'like.Alan*'));
    expect(likeHit.body.total).toBe(1);
  });

  it('in matches any of the listed values', async () => {
    const { body } = await getJson<ListBody>(q('display_name', 'in.(Ada Lovelace,Grace Hopper)'));
    expect(body.total).toBe(2);
  });

  it('is.null / is.notnull filter on a nullable column', async () => {
    const nul = await getJson<ListBody>(q('deleted_at', 'is.null'));
    expect(nul.body.total).toBe(3);
    const notnull = await getJson<ListBody>(q('deleted_at', 'is.notnull'));
    expect(notnull.body.total).toBe(0);
  });

  it('numeric comparison operators filter on selling_price', async () => {
    const gt = await getJson<ListBody>('/inventory_items?selling_price=gt.10');
    expect(gt.body.total).toBe(1);
    const lt = await getJson<ListBody>('/inventory_items?selling_price=lt.10');
    expect(lt.body.total).toBe(0);
    const gte = await getJson<ListBody>('/inventory_items?selling_price=gte.42.50');
    expect(gte.body.total).toBe(1);
    const lte = await getJson<ListBody>('/inventory_items?selling_price=lte.10');
    expect(lte.body.total).toBe(0);
  });

  it('ANDs a gte/lte range on the same column', async () => {
    const inRange = await getJson<ListBody>('/inventory_items?selling_price=gte.40&selling_price=lte.45');
    expect(inRange.body.total).toBe(1);
    const outOfRange = await getJson<ListBody>(
      '/inventory_items?selling_price=gte.0&selling_price=lte.40',
    );
    expect(outOfRange.body.total).toBe(0);
  });

  it('rejects a type-incompatible operator with 400, not 500 (#76)', async () => {
    // ILIKE on a numeric column — caught statically before the query runs.
    const ilikeNumeric = await getJson(`/inventory_items?selling_price=ilike.*5*`);
    expect(ilikeNumeric.status).toBe(400);
    // is.true on a text column — also caught statically.
    const isTrueText = await getJson(`/authors?display_name=is.true`);
    expect(isTrueText.status).toBe(400);
  });

  it('rejects a value-format mismatch with 400, not 500 (#76)', async () => {
    // A non-numeric value on a numeric column is rejected pre-execution by the
    // filter value check, so it never reaches PostgreSQL as a 500.
    const { status, body } = await getJson<{ error?: { code: string } }>(
      `/inventory_items?selling_price=eq.abc`,
    );
    expect(status).toBe(400);
    expect(body.error?.code).toBe('bad_request');
  });

  it('rejects numeric precision / float range overflow with 400, not 500 (#81)', async () => {
    // numeric(12,2): an integer part beyond 10 digits would raise a PostgreSQL
    // "numeric field overflow" (500); it is now rejected pre-execution.
    const overflow = await getJson<{ error?: { code: string } }>(
      `/inventory_items?selling_price=eq.999999999999999999999`,
    );
    expect(overflow.status).toBe(400);
    expect(overflow.body.error?.code).toBe('bad_request');
    // The exponent form that expands past the budget is caught too.
    const expOverflow = await getJson(`/inventory_items?selling_price=eq.1e20`);
    expect(expOverflow.status).toBe(400);
    // A value within numeric(12,2) still runs (200), proving no false reject.
    const ok = await getJson<ListBody>(`/inventory_items?selling_price=lte.1000000.00`);
    expect(ok.status).toBe(200);
    // real: a magnitude beyond the float4 range would raise "out of range" (500);
    // it is rejected as 400 instead. An in-range value still runs.
    const floatOverflow = await getJson(`/float_samples?approx=gt.1e40`);
    expect(floatOverflow.status).toBe(400);
    const floatOk = await getJson<ListBody>(`/float_samples?approx=lt.1000`);
    expect(floatOk.status).toBe(200);
    // real underflow: a nonzero value that rounds to zero is also rejected (PG
    // raises "value out of range: underflow" otherwise).
    const floatUnderflow = await getJson(`/float_samples?approx=eq.1e-46`);
    expect(floatUnderflow.status).toBe(400);
  });

  it('rejects a non-text relation-options search field with 400 (#76)', async () => {
    // `fields` is request-controlled; ILIKE'ing a numeric column would 500.
    const { status, body } = await getJson<{ error?: { code: string } }>(
      `/inventory_items?as=options&label=status&fields=selling_price&q=x`,
    );
    expect(status).toBe(400);
    expect(body.error?.code).toBe('bad_request');
  });

  it('documents the filter grammar as per-column query parameters in OpenAPI', async () => {
    const { body } = await getJson<{
      paths: Record<string, { get?: { parameters?: { name: string; description?: string }[] } }>;
    }>('/openapi.json');
    const params = body.paths['/authors'].get?.parameters ?? [];
    const displayName = params.find((p) => p.name === 'display_name');
    expect(displayName?.description).toContain('eq, neq, gt, gte, lt, lte, like, ilike, in, is');
  });

  it('rejects a malformed in. list with 400', async () => {
    const { status } = await getJson(q('display_name', 'in.Ada Lovelace'));
    expect(status).toBe(400);
  });

  it('runs a full create -> get -> update -> delete loop', async () => {
    const created = await fetch(`${base}/authors`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ display_name: 'Katherine Johnson' }),
    });
    expect(created.status).toBe(201);
    const createdRow = (await created.json()) as { id: string; display_name: string };
    expect(createdRow.display_name).toBe('Katherine Johnson');
    const id = createdRow.id;

    const got = await getJson<{ display_name: string }>(`/authors/${id}`);
    expect(got.status).toBe(200);
    expect(got.body.display_name).toBe('Katherine Johnson');

    const updated = await fetch(`${base}/authors/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ display_name: 'Katherine G. Johnson' }),
    });
    expect(updated.status).toBe(200);
    expect(((await updated.json()) as { display_name: string }).display_name).toBe(
      'Katherine G. Johnson',
    );

    const deleted = await fetch(`${base}/authors/${id}`, { method: 'DELETE' });
    expect(deleted.status).toBe(200);

    const gone = await getJson(`/authors/${id}`);
    expect(gone.status).toBe(404);
  });

  it('returns relation-select options via ?as=options', async () => {
    const { status, body } = await getJson<{ options: { id: string; label: string }[] }>(
      '/authors?as=options&label=display_name&fields=display_name&q=turing',
    );
    expect(status).toBe(200);
    expect(body.options).toHaveLength(1);
    expect(body.options[0].label).toBe('Alan Turing');
  });

  it('rejects writes to a VIEW with 405', async () => {
    const r = await fetch(`${base}/vw_inventory_for_sale`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ x: 1 }),
    });
    expect(r.status).toBe(405);
  });

  it('rejects an unknown column on create with 400', async () => {
    const r = await fetch(`${base}/authors`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bogus: 1 }),
    });
    expect(r.status).toBe(400);
  });

  it('serves a COMMENT-enriched OpenAPI 3.1 document', async () => {
    type Doc = {
      openapi: string;
      paths: Record<string, Record<string, unknown>>;
      components: {
        schemas: Record<
          string,
          {
            description?: string;
            'x-kozou-ai'?: string;
            properties: Record<string, { enum?: unknown[]; 'x-kozou-widget'?: string }>;
          }
        >;
      };
    };
    const { status, body } = await getJson<Doc>('/openapi.json');
    expect(status).toBe(200);
    expect(body.openapi).toBe('3.1.0');

    // tables expose write paths; views are read-only
    expect(body.paths['/authors'].post).toBeDefined();
    expect(body.paths['/vw_inventory_for_sale'].post).toBeUndefined();

    // COMMENT-derived metadata is baked into the component schemas
    const inv = body.components.schemas[`${db.schema}.inventory_items`];
    expect(inv.description).toContain('Inventory items available for sale');
    expect(inv['x-kozou-ai']).toContain('vw_inventory_for_sale');
    expect(inv.properties.status.enum).toEqual(
      expect.arrayContaining(['for_sale', 'reserved', 'sold']),
    );
    expect(inv.properties.status['x-kozou-widget']).toBe('enum-select');
    expect(inv.properties.selling_price['x-kozou-widget']).toBe('currency');

    expect(body.components.schemas[`${db.schema}.authors`].description).toBe('Authors of books.');
  });

  it('embeds a forward to-one relation as a nested object (?embed=authors)', async () => {
    const { status, body } = await getJson<{
      rows: { author_id: string; authors: { display_name: string } | null }[];
    }>('/books?embed=authors');
    expect(status).toBe(200);
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].authors?.display_name).toBe('Ada Lovelace');
    // the raw foreign-key scalar is preserved alongside the nested object
    expect(typeof body.rows[0].author_id).toBe('string');
  });

  it('embeds a multi-level chain (?embed=editions.books.authors)', async () => {
    const { status, body } = await getJson<{
      rows: { id: string; editions: { id: string; books: { authors: { display_name: string } } } }[];
    }>('/inventory_items?embed=editions.books.authors');
    expect(status).toBe(200);
    expect(body.rows[0].editions.books.authors.display_name).toBe('Ada Lovelace');
    // nested uuid survives the JSON round-trip as a string
    expect(typeof body.rows[0].editions.id).toBe('string');
  });

  it('embeds on the fetch-by-id route', async () => {
    const { status, body } = await getJson<{
      id: string;
      editions: { books: { authors: { display_name: string } } };
    }>(`/inventory_items/${inventoryItemId}?embed=editions.books.authors`);
    expect(status).toBe(200);
    expect(body.editions.books.authors.display_name).toBe('Ada Lovelace');
  });

  it('combines embed with pagination', async () => {
    const { status, body } = await getJson<{
      rows: { authors: { display_name: string } }[];
      pageSize: number;
    }>('/books?embed=authors&pageSize=10');
    expect(status).toBe(200);
    expect(body.pageSize).toBe(10);
    expect(body.rows[0].authors.display_name).toBe('Ada Lovelace');
  });

  it('leaves the row count unaffected by embedding', async () => {
    const plain = await getJson<ListBody>('/books');
    const embedded = await getJson<ListBody>('/books?embed=authors');
    expect(embedded.body.total).toBe(plain.body.total);
  });

  it('rejects an unknown embed relation with 400', async () => {
    const { status } = await getJson('/books?embed=bogus');
    expect(status).toBe(400);
  });

  it('rejects embedding on a VIEW with 400', async () => {
    const { status } = await getJson('/vw_inventory_for_sale?embed=anything');
    expect(status).toBe(400);
  });

  it('embeds a reverse one-to-many relation as an array (?embed=books)', async () => {
    const { status, body } = await getJson<{
      rows: { display_name: string; books: { title: string }[] }[];
    }>('/authors?embed=books&sort=display_name.asc');
    expect(status).toBe(200);
    const ada = body.rows.find((r) => r.display_name === 'Ada Lovelace')!;
    expect(Array.isArray(ada.books)).toBe(true);
    expect(ada.books).toHaveLength(1);
    expect(ada.books[0].title).toBe('Notes on the Analytical Engine');
    // an author with no books gets an empty array, not null
    const turing = body.rows.find((r) => r.display_name === 'Alan Turing')!;
    expect(turing.books).toEqual([]);
  });

  it('composes reverse embedding across two levels (?embed=books.editions)', async () => {
    const { body } = await getJson<{
      rows: { display_name: string; books: { editions: { isbn: string }[] }[] }[];
    }>('/authors?embed=books.editions');
    const ada = body.rows.find((r) => r.display_name === 'Ada Lovelace')!;
    expect(ada.books[0].editions[0].isbn).toBe('978-0-00-000000-1');
  });

  it('reflects embeddable relations in the OpenAPI document', async () => {
    const { body } = await getJson<{
      paths: Record<string, { get?: { parameters?: { name: string }[] } }>;
      components: {
        schemas: Record<string, { 'x-kozou-embeds'?: { field: string; target: string }[] }>;
      };
    }>('/openapi.json');
    const booksEmbeds = body.components.schemas[`${db.schema}.books`]['x-kozou-embeds'];
    expect(booksEmbeds?.some((e) => e.field === 'author_id')).toBe(true);
    expect(body.paths['/books'].get?.parameters?.some((p) => p.name === 'embed')).toBe(true);
  });

  // --- Composite primary key, item-by-id (Kozou v1.0 spec §3) --------------

  it('lists a composite-primary-key table', async () => {
    const { status, body } = await getJson<ListBody>('/order_lines');
    expect(status).toBe(200);
    expect(body.total).toBe(3);
  });

  it('fetches a row by its composite key and distinguishes the components', async () => {
    const first = await getJson<{ qty: number }>(`/order_lines/${ORDER_A},1`);
    expect(first.status).toBe(200);
    expect(first.body.qty).toBe(10);
    const second = await getJson<{ qty: number }>(`/order_lines/${ORDER_A},2`);
    expect(second.body.qty).toBe(20);
  });

  it('returns 400 when the composite key arity is wrong', async () => {
    const { status } = await getJson(`/order_lines/${ORDER_A}`); // one component for a 2-col PK
    expect(status).toBe(400);
  });

  it('returns 404 for a non-existent composite key', async () => {
    const { status } = await getJson(`/order_lines/${ORDER_A},999`);
    expect(status).toBe(404);
  });

  it('updates exactly the row addressed by its composite key', async () => {
    const updated = await fetch(`${base}/order_lines/${ORDER_A},1`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ qty: 99 }),
    });
    expect(updated.status).toBe(200);
    expect(((await updated.json()) as { qty: number }).qty).toBe(99);
    // the sibling row (same order_id, different line_no) is untouched
    const sibling = await getJson<{ qty: number }>(`/order_lines/${ORDER_A},2`);
    expect(sibling.body.qty).toBe(20);
  });

  it('deletes the row addressed by its composite key', async () => {
    const deleted = await fetch(`${base}/order_lines/${ORDER_B},1`, { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    const gone = await getJson(`/order_lines/${ORDER_B},1`);
    expect(gone.status).toBe(404);
  });

  it('returns composite array ids via ?as=options that round-trip as item ids', async () => {
    const { status, body } = await getJson<{
      options: { id: (string | number)[]; label: string }[];
    }>('/order_lines?as=options&label=qty');
    expect(status).toBe(200);
    // The untouched sibling row (ORDER_A, line 2, qty 20) is offered with its
    // key components in primary-key declaration order.
    const option = body.options.find((o) => o.id[0] === ORDER_A && o.id[1] === 2);
    expect(option).toBeDefined();
    expect(option?.label).toBe('20');
    // The array id, comma-joined, addresses the same row as an item id.
    const item = await getJson<{ qty: number }>(`/order_lines/${option!.id.join(',')}`);
    expect(item.status).toBe(200);
    expect(item.body.qty).toBe(20);
  });

  it('documents the composite key format in the OpenAPI {id} parameter', async () => {
    const { body } = await getJson<{
      paths: Record<string, { get?: { parameters?: { name: string; description?: string }[] } }>;
    }>('/openapi.json');
    const idParam = body.paths['/order_lines/{id}'].get?.parameters?.find((p) => p.name === 'id');
    expect(idParam?.description).toMatch(/composite primary key/i);
    expect(idParam?.description).toContain('order_id');
    expect(idParam?.description).toContain('line_no');
  });

  it('returns 404 for an unknown resource', async () => {
    const { status } = await getJson('/does_not_exist');
    expect(status).toBe(404);
  });
});
