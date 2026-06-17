import { describe, it, expect } from 'vitest';
import { handleApiRequest, parseListParams, type ApiHandlerDeps } from '../src/handler.js';
import type { ResourceLookup, Resource, ReverseRelation } from '../src/schema-lookup.js';
import { col, tableResource, viewResource, recordingDb, relation, type RowSet } from './helpers.js';
import { encodeCursor } from '../src/cursor.js';

function lookupOf(resources: Resource[]): ResourceLookup {
  const m = new Map<string, Resource>();
  const rev = new Map<string, ReverseRelation[]>();
  for (const r of resources) {
    m.set(r.name, r);
    m.set(r.qualifiedName, r);
    for (const rel of r.relations) {
      const qn = `${rel.references.schema}.${rel.references.table}`;
      const list = rev.get(qn) ?? [];
      list.push({ child: r, relation: rel });
      rev.set(qn, list);
    }
  }
  return {
    resolve: (n) => m.get(n),
    list: () => resources.map((r) => r.qualifiedName).sort(),
    reverse: (qn) => rev.get(qn) ?? [],
  };
}

const authors = tableResource('authors', [
  col('id', 'uuid', { isPrimaryKey: true, nullable: false }),
  col('display_name', 'text'),
]);
const vw = viewResource('vw_active', [col('id', 'uuid'), col('label', 'text')]);

// `authors` / `books` have a uuid primary key, and an item-id segment is now
// pre-flighted against the key type (#110): a non-uuid id segment 400s before
// the query runs. These valid uuids stand in for the prior throwaway ids.
const AUTHOR_ID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
const ABSENT_UUID = '00000000-0000-0000-0000-000000000000';
const BOOK_ID = '11111111-1111-1111-1111-111111111111';

function reqOf(method: string, path: string, qs = '', body?: unknown): {
  method: string;
  segments: string[];
  query: URLSearchParams;
  body?: unknown;
} {
  return {
    method,
    segments: path.split('/').filter((s) => s.length > 0),
    query: new URLSearchParams(qs),
    body,
  };
}

function depsWith(
  respond: (text: string, values: unknown[]) => RowSet,
  version?: string,
): { deps: ApiHandlerDeps; calls: { text: string; values: unknown[] }[] } {
  const { db, calls } = recordingDb(respond);
  return { deps: { db, lookup: lookupOf([authors, vw]), version }, calls };
}

const errorOf = (body: unknown): { code: string; message: string } =>
  (body as { error: { code: string; message: string } }).error;

describe('handleApiRequest — routing', () => {
  it('GET / returns service info and the resource list', async () => {
    const { deps } = depsWith(() => ({ rows: [], rowCount: 0 }), 'v-test');
    const r = await handleApiRequest(deps, reqOf('GET', '/'));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      name: 'kozou-api',
      version: 'v-test',
      resources: ['public.authors', 'public.vw_active'],
      functions: [],
    });
  });

  it('GET / reports a null version when none is configured', async () => {
    const { deps } = depsWith(() => ({ rows: [], rowCount: 0 }));
    const r = await handleApiRequest(deps, reqOf('GET', '/'));
    expect((r.body as { version: string | null }).version).toBeNull();
  });

  it('GET /<table> lists rows with total and runs a data + count query', async () => {
    const { deps, calls } = depsWith((text) =>
      text.includes('count(*)')
        ? { rows: [{ total: 2 }], rowCount: 1 }
        : { rows: [{ id: 'a' }, { id: 'b' }], rowCount: 2 },
    );
    const r = await handleApiRequest(deps, reqOf('GET', '/authors', 'pageSize=10'));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      rows: [{ id: 'a' }, { id: 'b' }],
      total: 2,
      page: 1,
      pageSize: 10,
      nextCursor: null,
      prevCursor: null,
    });
    expect(calls).toHaveLength(2);
  });

  it('GET /<table>?count=none skips the count query and reports total null (#177)', async () => {
    const { deps, calls } = depsWith(() => ({ rows: [{ id: 'a' }], rowCount: 1 }));
    const r = await handleApiRequest(deps, reqOf('GET', '/authors', 'count=none&pageSize=10'));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      rows: [{ id: 'a' }],
      total: null,
      page: 1,
      pageSize: 10,
      nextCursor: null,
      prevCursor: null,
    });
    // Only the data query ran — no count(*) and no EXPLAIN.
    expect(calls).toHaveLength(1);
    expect(calls[0].text).not.toContain('count(*)');
    expect(calls[0].text).not.toContain('EXPLAIN');
  });

  it('GET /<table>?count=estimated reads the planner estimate via EXPLAIN (#177)', async () => {
    const { deps, calls } = depsWith((text) =>
      text.includes('EXPLAIN')
        ? { rows: [{ 'QUERY PLAN': [{ Plan: { 'Plan Rows': 4242 } }] }], rowCount: 1 }
        : { rows: [{ id: 'a' }], rowCount: 1 },
    );
    const r = await handleApiRequest(deps, reqOf('GET', '/authors', 'count=estimated&pageSize=10'));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      rows: [{ id: 'a' }],
      total: 4242,
      page: 1,
      pageSize: 10,
      nextCursor: null,
      prevCursor: null,
    });
    expect(calls).toHaveLength(2);
    expect(calls.some((c) => c.text.startsWith('EXPLAIN (FORMAT JSON)'))).toBe(true);
    expect(calls.every((c) => !c.text.includes('count(*)'))).toBe(true);
  });

  it('GET /<table>?count=exact runs the precise count like the default (#177)', async () => {
    const { deps, calls } = depsWith((text) =>
      text.includes('count(*)')
        ? { rows: [{ total: 7 }], rowCount: 1 }
        : { rows: [{ id: 'a' }], rowCount: 1 },
    );
    const r = await handleApiRequest(deps, reqOf('GET', '/authors', 'count=exact&pageSize=10'));
    expect(r.body).toEqual({
      rows: [{ id: 'a' }],
      total: 7,
      page: 1,
      pageSize: 10,
      nextCursor: null,
      prevCursor: null,
    });
    expect(calls).toHaveLength(2);
  });

  it('rejects an unknown count mode with 400 before any query runs (#177)', async () => {
    const { deps, calls } = depsWith(() => ({ rows: [], rowCount: 0 }));
    const r = await handleApiRequest(deps, reqOf('GET', '/authors', 'count=bogus'));
    expect(r.status).toBe(400);
    expect(errorOf(r.body).code).toBe('bad_request');
    expect(calls).toHaveLength(0);
  });

  it('count is a control key, so it shadows a same-named column from the filter grammar (#177)', async () => {
    // A table with a column literally named `count`. `?count=eq.5` is read as
    // the count-mode control (not a filter) — like `page`/`sort`, the control
    // key shadows the column — so the invalid mode value `eq.5` 400s rather
    // than filtering. (Documented limitation, consistent with the other
    // reserved control keys.)
    const metrics = tableResource('metrics', [
      col('id', 'uuid', { isPrimaryKey: true, nullable: false }),
      col('count', 'number', { dataType: 'integer' }),
    ]);
    const { db, calls } = recordingDb(() => ({ rows: [], rowCount: 0 }));
    const deps: ApiHandlerDeps = { db, lookup: lookupOf([metrics]) };
    const r = await handleApiRequest(deps, reqOf('GET', '/metrics', 'count=eq.5'));
    expect(r.status).toBe(400);
    expect(errorOf(r.body).code).toBe('bad_request');
    expect(calls).toHaveLength(0);
  });

  it('?after decodes to a keyset query (no OFFSET) and emits cursors (#185)', async () => {
    const after = encodeCursor([{ field: 'id', order: 'asc' }], [AUTHOR_ID]);
    // pageSize=2 over-fetches 3 (LIMIT pageSize + 1); returning the sentinel row
    // signals "more", so nextCursor is emitted and the page is trimmed to 2.
    // Each row carries the private text-cast cursor-key alias the real query
    // projects (`__kozou_cursor_0` for the single-column id order); the handler
    // encodes the cursor from it and strips it from the response.
    const { deps, calls } = depsWith((text) =>
      text.includes('count(*)')
        ? { rows: [{ total: 9 }], rowCount: 1 }
        : {
            rows: [
              { id: 'p', __kozou_cursor_0: 'p' },
              { id: 'q', __kozou_cursor_0: 'q' },
              { id: 'r', __kozou_cursor_0: 'r' },
            ],
            rowCount: 3,
          },
    );
    const r = await handleApiRequest(deps, reqOf('GET', '/authors', `pageSize=2&after=${after}`));
    expect(r.status).toBe(200);
    const dataCall = calls.find((c) => !c.text.includes('count(*)'))!;
    expect(dataCall.text).toContain('WHERE "id" > $1');
    expect(dataCall.text).not.toContain('OFFSET');
    const body = r.body as {
      rows: { id: string }[];
      nextCursor: string | null;
      prevCursor: string | null;
      total: number;
    };
    expect(body.rows.map((x) => x.id)).toEqual(['p', 'q']); // sentinel trimmed off
    expect(body.total).toBe(9); // the full filtered count, not "rows after the cursor"
    expect(body.nextCursor).not.toBeNull(); // sentinel present ⇒ more
    expect(body.prevCursor).not.toBeNull(); // arrived via a cursor ⇒ can page back
  });

  it('rejects a malformed ?after cursor with a 400 before any query runs (#185)', async () => {
    const { deps, calls } = depsWith(() => ({ rows: [], rowCount: 0 }));
    const r = await handleApiRequest(deps, reqOf('GET', '/authors', 'after=zzzz'));
    expect(r.status).toBe(400);
    expect(errorOf(r.body).code).toBe('bad_request');
    expect(calls).toHaveLength(0);
  });

  it('rejects a forged cursor whose boundary value is not a string (400) (#185)', async () => {
    // A genuine cursor only carries text values; a forged non-string (here an
    // array) is rejected at decode, before it can bind a non-scalar.
    const forged = Buffer.from(
      JSON.stringify({ o: [['id', 'asc']], v: [['nested']] }),
      'utf8',
    ).toString('base64url');
    const { deps, calls } = depsWith(() => ({ rows: [], rowCount: 0 }));
    const r = await handleApiRequest(deps, reqOf('GET', '/authors', `after=${forged}`));
    expect(r.status).toBe(400);
    expect(errorOf(r.body).code).toBe('bad_request');
    expect(calls).toHaveLength(0);
  });

  it('GET /<table>/<id> returns the row when found', async () => {
    const { deps } = depsWith(() => ({ rows: [{ id: 'abc', display_name: 'Ada' }], rowCount: 1 }));
    const r = await handleApiRequest(deps, reqOf('GET', `/authors/${AUTHOR_ID}`));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ id: 'abc', display_name: 'Ada' });
  });

  it('GET /<table>/<id> returns 404 when the row is missing', async () => {
    const { deps } = depsWith(() => ({ rows: [], rowCount: 0 }));
    const r = await handleApiRequest(deps, reqOf('GET', `/authors/${ABSENT_UUID}`));
    expect(r.status).toBe(404);
    expect(errorOf(r.body).code).toBe('not_found');
  });

  it('returns 404 for an unknown resource', async () => {
    const { deps } = depsWith(() => ({ rows: [], rowCount: 0 }));
    const r = await handleApiRequest(deps, reqOf('GET', '/nope'));
    expect(r.status).toBe(404);
    expect(errorOf(r.body).code).toBe('not_found');
  });

  it('POST /<table> creates a row and returns 201', async () => {
    const { deps, calls } = depsWith((text) =>
      text.startsWith('INSERT')
        ? { rows: [{ id: 'new', display_name: 'Ada' }], rowCount: 1 }
        : { rows: [], rowCount: 0 },
    );
    const r = await handleApiRequest(deps, reqOf('POST', '/authors', '', { display_name: 'Ada' }));
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ id: 'new', display_name: 'Ada' });
    expect(calls[0].text).toContain('INSERT INTO "public"."authors"');
    expect(calls[0].values).toEqual(['Ada']);
  });

  it('rejects a non-object create body with 400', async () => {
    const { deps } = depsWith(() => ({ rows: [], rowCount: 0 }));
    const r = await handleApiRequest(deps, reqOf('POST', '/authors', '', 'not-an-object'));
    expect(r.status).toBe(400);
    expect(errorOf(r.body).code).toBe('bad_request');
  });

  it('PATCH /<table>/<id> updates and returns the row', async () => {
    const { deps } = depsWith((text) =>
      text.startsWith('UPDATE')
        ? { rows: [{ id: 'abc', display_name: 'Ada2' }], rowCount: 1 }
        : { rows: [], rowCount: 0 },
    );
    const r = await handleApiRequest(deps, reqOf('PATCH', `/authors/${AUTHOR_ID}`, '', { display_name: 'Ada2' }));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ id: 'abc', display_name: 'Ada2' });
  });

  it('PATCH returns 404 when the row is missing', async () => {
    const { deps } = depsWith(() => ({ rows: [], rowCount: 0 }));
    const r = await handleApiRequest(deps, reqOf('PATCH', `/authors/${ABSENT_UUID}`, '', { display_name: 'x' }));
    expect(r.status).toBe(404);
  });

  it('DELETE /<table>/<id> removes and returns the row', async () => {
    const { deps } = depsWith((text) =>
      text.startsWith('DELETE') ? { rows: [{ id: 'abc' }], rowCount: 1 } : { rows: [], rowCount: 0 },
    );
    const r = await handleApiRequest(deps, reqOf('DELETE', `/authors/${AUTHOR_ID}`));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ id: 'abc' });
  });

  it('DELETE returns 404 when the row is missing', async () => {
    const { deps } = depsWith(() => ({ rows: [], rowCount: 0 }));
    const r = await handleApiRequest(deps, reqOf('DELETE', `/authors/${ABSENT_UUID}`));
    expect(r.status).toBe(404);
  });

  it('400s an id segment that cannot parse as the key type, before querying (#110)', async () => {
    const { deps, calls } = depsWith(() => ({ rows: [], rowCount: 0 }));
    const r = await handleApiRequest(deps, reqOf('GET', '/authors/not-a-uuid'));
    expect(r.status).toBe(400);
    expect(errorOf(r.body).code).toBe('bad_request');
    expect(calls).toHaveLength(0); // never reached the database (was a 500 before)
  });

  it('400s a malformed scalar write-body value, before querying (#110)', async () => {
    const { deps, calls } = depsWith(() => ({ rows: [], rowCount: 0 }));
    const r = await handleApiRequest(deps, reqOf('POST', '/authors', '', { id: 'zzz' }));
    expect(r.status).toBe(400);
    expect(errorOf(r.body).code).toBe('bad_request');
    expect(calls).toHaveLength(0);
  });

  it('rejects writes to a read-only view with 405', async () => {
    const { deps } = depsWith(() => ({ rows: [], rowCount: 0 }));
    const r = await handleApiRequest(deps, reqOf('POST', '/vw_active', '', { x: 1 }));
    expect(r.status).toBe(405);
  });

  it('returns 405 for an unsupported method on a collection', async () => {
    const { deps } = depsWith(() => ({ rows: [], rowCount: 0 }));
    const r = await handleApiRequest(deps, reqOf('PUT', '/authors', '', {}));
    expect(r.status).toBe(405);
  });

  it('returns 405 for an unsupported method on an item', async () => {
    const { deps } = depsWith(() => ({ rows: [], rowCount: 0 }));
    const r = await handleApiRequest(deps, reqOf('PUT', '/authors/abc', '', {}));
    expect(r.status).toBe(405);
  });

  it('GET /<table>?as=options returns id/label pairs', async () => {
    const { deps, calls } = depsWith(() => ({ rows: [{ id: '1', display_name: 'Ada' }], rowCount: 1 }));
    const r = await handleApiRequest(
      deps,
      reqOf('GET', '/authors', 'as=options&label=display_name&fields=display_name&q=ad'),
    );
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ options: [{ id: '1', label: 'Ada' }] });
    expect(calls[0].text).toContain('SELECT "id", "display_name" FROM "public"."authors"');
    expect(calls[0].values).toEqual(['%ad%', 20]);
  });

  it('relation options require a label parameter (400)', async () => {
    const { deps } = depsWith(() => ({ rows: [], rowCount: 0 }));
    const r = await handleApiRequest(deps, reqOf('GET', '/authors', 'as=options'));
    expect(r.status).toBe(400);
  });

  it('GET /<table>?as=options returns array ids for a composite-key table', async () => {
    const lines = tableResource(
      'order_lines',
      [
        col('order_id', 'uuid', { isPrimaryKey: true, nullable: false }),
        col('line_no', 'number', { dataType: 'integer', isPrimaryKey: true, nullable: false }),
        col('note', 'text'),
      ],
      ['order_id', 'line_no'],
    );
    const { db, calls } = recordingDb(() => ({
      rows: [{ order_id: 'o1', line_no: 2, note: 'second line' }],
      rowCount: 1,
    }));
    const deps: ApiHandlerDeps = { db, lookup: lookupOf([lines]) };
    const r = await handleApiRequest(deps, reqOf('GET', '/order_lines', 'as=options&label=note'));
    expect(r.status).toBe(200);
    // The id components follow primary-key declaration order, forming a
    // valid item id for the resource.
    expect(r.body).toEqual({ options: [{ id: ['o1', 2], label: 'second line' }] });
    expect(calls[0].text).toContain('SELECT "order_id", "line_no", "note"');
  });

  it('returns 404 for a path deeper than two segments', async () => {
    const { deps } = depsWith(() => ({ rows: [], rowCount: 0 }));
    const r = await handleApiRequest(deps, reqOf('GET', '/authors/abc/extra'));
    expect(r.status).toBe(404);
  });

  it('returns 400 when fetching a view by id (no primary key)', async () => {
    const { deps } = depsWith(() => ({ rows: [], rowCount: 0 }));
    const r = await handleApiRequest(deps, reqOf('GET', '/vw_active/1'));
    expect(r.status).toBe(400);
    expect(errorOf(r.body).code).toBe('bad_request');
  });

  it('maps an unexpected error to a 500 with a generic message (detail stays server-side)', async () => {
    const { deps } = depsWith(() => {
      throw new Error('secret internal detail');
    });
    const r = await handleApiRequest(deps, reqOf('GET', '/authors'));
    expect(r.status).toBe(500);
    expect(errorOf(r.body)).toEqual({ code: 'internal', message: 'Internal server error.' });
  });

  describe('database error mapping (SQLSTATE -> HTTP)', () => {
    // What node-postgres raises for a server error: an Error carrying the
    // SQLSTATE in `code`, a `severity`, and the violated constraint/column.
    function pgError(
      code: string,
      message: string,
      extra: { constraint?: string; column?: string } = {},
    ): Error {
      return Object.assign(new Error(message), { code, severity: 'ERROR', ...extra });
    }

    async function failingWith(err: Error, method = 'GET', body?: unknown) {
      const { deps } = depsWith(() => {
        throw err;
      });
      return handleApiRequest(deps, reqOf(method, '/authors', '', body));
    }

    it('42501 (privilege / row-level security) -> 403 forbidden, raw message withheld', async () => {
      const raw = 'permission denied for schema app';
      const r = await failingWith(pgError('42501', raw));
      expect(r.status).toBe(403);
      expect(errorOf(r.body)).toEqual({ code: 'forbidden', message: 'Permission denied.' });
      expect(JSON.stringify(r.body)).not.toContain('app');
    });

    it('42501 on a write (RLS WITH CHECK) -> 403 as well', async () => {
      const r = await failingWith(
        pgError('42501', 'new row violates row-level security policy for table "authors"'),
        'POST',
        { display_name: 'x' },
      );
      expect(r.status).toBe(403);
      expect(errorOf(r.body).code).toBe('forbidden');
    });

    it('23505 (unique violation) -> 409 conflict, constraint name withheld', async () => {
      // The error object cannot prove the identifier belongs to the exposed
      // surface, so it must never be echoed — generic body, detail in the log.
      const r = await failingWith(
        pgError('23505', 'duplicate key value violates unique constraint "authors_pkey"', {
          constraint: 'authors_pkey',
        }),
        'POST',
        { display_name: 'x' },
      );
      expect(r.status).toBe(409);
      expect(errorOf(r.body)).toEqual({
        code: 'conflict',
        message: 'Unique constraint violation.',
      });
      expect(JSON.stringify(r.body)).not.toContain('authors_pkey');
    });

    it('23503 (foreign-key violation) -> 409 conflict, hidden-table constraint withheld', async () => {
      // A delete on an exposed table can be rejected by a foreign key from a
      // table that is not exposed at all — its constraint name must not leak.
      const r = await failingWith(
        pgError(
          '23503',
          'update or delete on table "authors" violates foreign key constraint "hidden_audit_author_id_fkey"',
          { constraint: 'hidden_audit_author_id_fkey' },
        ),
        'POST',
        { display_name: 'x' },
      );
      expect(r.status).toBe(409);
      expect(errorOf(r.body)).toEqual({
        code: 'conflict',
        message: 'Foreign key constraint violation.',
      });
      expect(JSON.stringify(r.body)).not.toContain('hidden_audit');
    });

    it('23502 (not-null violation) -> 400 constraint_violation, column name withheld', async () => {
      const r = await failingWith(
        pgError('23502', 'null value in column "display_name" violates not-null constraint', {
          column: 'display_name',
        }),
        'POST',
        {},
      );
      expect(r.status).toBe(400);
      expect(errorOf(r.body)).toEqual({
        code: 'constraint_violation',
        message: 'Not-null constraint violation.',
      });
      expect(JSON.stringify(r.body)).not.toContain('display_name');
    });

    it('23514 (check violation) -> 400 constraint_violation', async () => {
      const r = await failingWith(
        pgError('23514', 'new row violates check constraint "authors_name_check"', {
          constraint: 'authors_name_check',
        }),
        'POST',
        { display_name: '' },
      );
      expect(r.status).toBe(400);
      expect(errorOf(r.body)).toEqual({
        code: 'constraint_violation',
        message: 'Check constraint violation.',
      });
      expect(JSON.stringify(r.body)).not.toContain('authors_name_check');
    });

    it('22xxx data exceptions stay 500 (deliberately unmapped: pre-flight owns input validation)', async () => {
      const r = await failingWith(pgError('22P02', 'invalid input syntax for type uuid: "zzz"'));
      expect(r.status).toBe(500);
      expect(errorOf(r.body)).toEqual({ code: 'internal', message: 'Internal server error.' });
    });

    it('a non-database error with a 5-char code is not mistaken for a SQLSTATE', async () => {
      // No `severity` -> not database-shaped, even though the code matches.
      const r = await failingWith(Object.assign(new Error('boom'), { code: '42501' }));
      expect(r.status).toBe(500);
      expect(errorOf(r.body).code).toBe('internal');
    });

    it('driver-level codes (ECONNREFUSED) stay 500', async () => {
      const r = await failingWith(
        Object.assign(new Error('connect ECONNREFUSED'), {
          code: 'ECONNREFUSED',
          severity: 'FATAL',
        }),
      );
      expect(r.status).toBe(500);
      expect(errorOf(r.body).code).toBe('internal');
    });
  });

  it('serves the OpenAPI document at GET /openapi.json when configured', async () => {
    const { db } = recordingDb(() => ({ rows: [], rowCount: 0 }));
    const deps: ApiHandlerDeps = {
      db,
      lookup: lookupOf([authors, vw]),
      openapi: { openapi: '3.1.0', paths: {} },
    };
    const r = await handleApiRequest(deps, reqOf('GET', '/openapi.json'));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ openapi: '3.1.0', paths: {} });
  });

  it('returns 404 for /openapi.json when not configured', async () => {
    const { deps } = depsWith(() => ({ rows: [], rowCount: 0 }));
    const r = await handleApiRequest(deps, reqOf('GET', '/openapi.json'));
    expect(r.status).toBe(404);
  });
});

describe('parseListParams', () => {
  it('parses pagination, search, sort, and column filters', () => {
    const p = parseListParams(
      new URLSearchParams('page=2&pageSize=10&search=foo&sort=name.desc,age&status=active&kind=x'),
    );
    expect(p.page).toBe(2);
    expect(p.pageSize).toBe(10);
    expect(p.search).toBe('foo');
    expect(p.sort).toEqual([
      { field: 'name', order: 'desc' },
      { field: 'age', order: 'asc' },
    ]);
    expect(p.filters).toEqual([
      { column: 'status', op: 'eq', value: 'active' },
      { column: 'kind', op: 'eq', value: 'x' },
    ]);
  });

  it('parses the `<op>.<value>` grammar; a bare value means eq', () => {
    const p = parseListParams(
      new URLSearchParams(
        'price=gte.10&price=lte.20&name=ilike.*ada*&tag=in.(a,b,c)&deleted_at=is.null&status=active',
      ),
    );
    expect(p.filters).toEqual([
      { column: 'price', op: 'gte', value: '10' },
      { column: 'price', op: 'lte', value: '20' },
      { column: 'name', op: 'ilike', value: '*ada*' },
      { column: 'tag', op: 'in', values: ['a', 'b', 'c'] },
      { column: 'deleted_at', op: 'is', keyword: 'null' },
      { column: 'status', op: 'eq', value: 'active' },
    ]);
  });

  it('an in.() value may contain a comma when double-quoted (#77)', () => {
    const p = parseListParams(new URLSearchParams({ tag: 'in.("a,b",c)' }));
    expect(p.filters).toEqual([{ column: 'tag', op: 'in', values: ['a,b', 'c'] }]);
  });

  it('in.() unescapes a backslash-quote and backslash-backslash in a quoted value (#77)', () => {
    // raw inner: "a\"b","c\\d"  ->  values a"b and c\d
    const p = parseListParams(new URLSearchParams({ tag: 'in.("a\\"b","c\\\\d")' }));
    expect(p.filters).toEqual([{ column: 'tag', op: 'in', values: ['a"b', 'c\\d'] }]);
  });

  it('an unquoted in.() list is unchanged, and a literal " in an unquoted value stays literal (#77)', () => {
    // Backward compatibility: no leading quote -> verbatim comma split, embedded
    // quote kept; a percent-encoded comma already decoded to a separator.
    const p = parseListParams(new URLSearchParams({ tag: 'in.(a,b,c)', note: 'in.(x"y,z)' }));
    expect(p.filters).toEqual([
      { column: 'tag', op: 'in', values: ['a', 'b', 'c'] },
      { column: 'note', op: 'in', values: ['x"y', 'z'] },
    ]);
  });

  it('an unterminated quoted in.() value is a 400 (#77)', () => {
    expect(() => parseListParams(new URLSearchParams({ tag: 'in.("a,b)' }))).toThrow(
      /unterminated quoted value/,
    );
  });

  it('in.() rejects text after a closing quote (#77)', () => {
    expect(() => parseListParams(new URLSearchParams({ tag: 'in.("a"x)' }))).toThrow(
      /unexpected text after a quoted value/,
    );
  });

  it('in.() keeps a trailing comma after a quoted value as a final empty value (#77)', () => {
    const p = parseListParams(new URLSearchParams({ tag: 'in.("a",)' }));
    expect(p.filters).toEqual([{ column: 'tag', op: 'in', values: ['a', ''] }]);
  });

  it('treats an unknown operator prefix as a literal equality value', () => {
    // "1.5" has a dot but "1" is not an operator -> eq on the whole value.
    const p = parseListParams(new URLSearchParams('price=1.5&note=foo.bar'));
    expect(p.filters).toEqual([
      { column: 'price', op: 'eq', value: '1.5' },
      { column: 'note', op: 'eq', value: 'foo.bar' },
    ]);
  });

  it('keeps the explicit eq. prefix verbatim (escaping an op-like value)', () => {
    const p = parseListParams(new URLSearchParams('name=eq.in.crowd'));
    expect(p.filters).toEqual([{ column: 'name', op: 'eq', value: 'in.crowd' }]);
  });

  it('rejects a malformed in. list and an unknown is. keyword with 400', () => {
    expect(() => parseListParams(new URLSearchParams('tag=in.a,b'))).toThrow(/must look like/);
    expect(() => parseListParams(new URLSearchParams('flag=is.maybe'))).toThrow(
      /is\.null, is\.notnull, is\.true, is\.false/,
    );
  });

  it('treats an empty search and non-numeric page as absent', () => {
    const p = parseListParams(new URLSearchParams('search=&page=abc'));
    expect(p.search).toBeUndefined();
    expect(p.page).toBeUndefined();
  });

  it('ignores empty sort tokens and an unrecognised order suffix', () => {
    const p = parseListParams(new URLSearchParams('sort=a,,b.bogus'));
    expect(p.sort).toEqual([
      { field: 'a', order: 'asc' },
      { field: 'b.bogus', order: 'asc' },
    ]);
  });

  it('returns no filters/sort when none are present', () => {
    const p = parseListParams(new URLSearchParams(''));
    expect(p.filters).toBeUndefined();
    expect(p.sort).toBeUndefined();
  });
});

describe('handleApiRequest — embed', () => {
  const authorsT = tableResource('authors', [
    col('id', 'uuid', { isPrimaryKey: true }),
    col('display_name', 'text'),
  ]);
  const booksT = tableResource(
    'books',
    [col('id', 'uuid', { isPrimaryKey: true }), col('author_id', 'uuid'), col('title', 'text')],
    ['id'],
    'public',
    [relation('author_id', 'authors')],
  );
  const embedLookup = lookupOf([authorsT, booksT]);

  function embedDeps(respond: (text: string, values: unknown[]) => RowSet): {
    deps: ApiHandlerDeps;
    calls: { text: string; values: unknown[] }[];
  } {
    const { db, calls } = recordingDb(respond);
    return { deps: { db, lookup: embedLookup }, calls };
  }

  it('GET /books?embed=authors issues a data query carrying the embed fragment', async () => {
    const { deps, calls } = embedDeps((text) =>
      text.includes('count(*)')
        ? { rows: [{ total: 1 }], rowCount: 1 }
        : {
            rows: [
              { id: 'b1', author_id: 'a1', title: 'T', authors: { id: 'a1', display_name: 'Ada' } },
            ],
            rowCount: 1,
          },
    );
    const r = await handleApiRequest(deps, reqOf('GET', '/books', 'embed=authors'));
    expect(r.status).toBe(200);
    expect(calls[0].text).toContain('AS "authors"');
    expect(calls).toHaveLength(2);
    expect((r.body as { rows: { authors: unknown }[] }).rows[0].authors).toEqual({
      id: 'a1',
      display_name: 'Ada',
    });
  });

  it('does not treat embed as a column-equality filter', async () => {
    const { deps, calls } = embedDeps((text) =>
      text.includes('count(*)') ? { rows: [{ total: 0 }], rowCount: 1 } : { rows: [], rowCount: 0 },
    );
    await handleApiRequest(deps, reqOf('GET', '/books', 'embed=authors'));
    expect(calls[0].text).not.toContain('"embed"');
  });

  it('GET /books/<id>?embed=authors splices the fragment into the by-id query', async () => {
    const { deps, calls } = embedDeps(() => ({
      rows: [{ id: 'b1', authors: { id: 'a1' } }],
      rowCount: 1,
    }));
    const r = await handleApiRequest(deps, reqOf('GET', `/books/${BOOK_ID}`, 'embed=authors'));
    expect(r.status).toBe(200);
    expect(calls[0].text).toContain('AS "authors"');
    expect(calls[0].text).toContain('WHERE "id" = $1');
  });

  it('returns 400 for an unknown embed relation', async () => {
    const { deps } = embedDeps(() => ({ rows: [], rowCount: 0 }));
    const r = await handleApiRequest(deps, reqOf('GET', '/books', 'embed=nope'));
    expect(r.status).toBe(400);
    expect(errorOf(r.body).code).toBe('bad_request');
  });

  it('GET /authors?embed=books renders a reverse to-many aggregate', async () => {
    const { deps, calls } = embedDeps((text) =>
      text.includes('count(*)')
        ? { rows: [{ total: 1 }], rowCount: 1 }
        : { rows: [{ id: 'a1', display_name: 'Ada', books: [{ id: 'b1' }] }], rowCount: 1 },
    );
    const r = await handleApiRequest(deps, reqOf('GET', '/authors', 'embed=books'));
    expect(r.status).toBe(200);
    expect(calls[0].text).toContain('jsonb_agg');
    expect(calls[0].text).toContain('AS "books"');
    expect((r.body as { rows: { books: unknown[] }[] }).rows[0].books).toEqual([{ id: 'b1' }]);
  });
});
