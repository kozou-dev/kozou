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

  it('returns 404 for an unknown resource', async () => {
    const { status } = await getJson('/does_not_exist');
    expect(status).toBe(404);
  });
});
