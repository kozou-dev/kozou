import { describe, it, expect } from 'vitest';
import { handleApiRequest, parseListParams, type ApiHandlerDeps } from '../src/handler.js';
import type { ResourceLookup, Resource } from '../src/schema-lookup.js';
import { col, tableResource, viewResource, recordingDb, type RowSet } from './helpers.js';

function lookupOf(resources: Resource[]): ResourceLookup {
  const m = new Map<string, Resource>();
  for (const r of resources) {
    m.set(r.name, r);
    m.set(r.qualifiedName, r);
  }
  return { resolve: (n) => m.get(n), list: () => resources.map((r) => r.qualifiedName).sort() };
}

const authors = tableResource('authors', [
  col('id', 'uuid', { isPrimaryKey: true, nullable: false }),
  col('display_name', 'text'),
]);
const vw = viewResource('vw_active', [col('id', 'uuid'), col('label', 'text')]);

function reqOf(method: string, path: string, qs = ''): {
  method: string;
  segments: string[];
  query: URLSearchParams;
} {
  return { method, segments: path.split('/').filter((s) => s.length > 0), query: new URLSearchParams(qs) };
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
    expect(r.body).toEqual({ rows: [{ id: 'a' }, { id: 'b' }], total: 2, page: 1, pageSize: 10 });
    expect(calls).toHaveLength(2);
  });

  it('GET /<table>/<id> returns the row when found', async () => {
    const { deps } = depsWith(() => ({ rows: [{ id: 'abc', display_name: 'Ada' }], rowCount: 1 }));
    const r = await handleApiRequest(deps, reqOf('GET', '/authors/abc'));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ id: 'abc', display_name: 'Ada' });
  });

  it('GET /<table>/<id> returns 404 when the row is missing', async () => {
    const { deps } = depsWith(() => ({ rows: [], rowCount: 0 }));
    const r = await handleApiRequest(deps, reqOf('GET', '/authors/missing'));
    expect(r.status).toBe(404);
    expect(errorOf(r.body).code).toBe('not_found');
  });

  it('returns 404 for an unknown resource', async () => {
    const { deps } = depsWith(() => ({ rows: [], rowCount: 0 }));
    const r = await handleApiRequest(deps, reqOf('GET', '/nope'));
    expect(r.status).toBe(404);
    expect(errorOf(r.body).code).toBe('not_found');
  });

  it('returns 405 for non-GET on a collection (create lands in Phase 2)', async () => {
    const { deps } = depsWith(() => ({ rows: [], rowCount: 0 }));
    const r = await handleApiRequest(deps, reqOf('POST', '/authors'));
    expect(r.status).toBe(405);
    expect(errorOf(r.body).code).toBe('method_not_allowed');
  });

  it('returns 405 for non-GET on an item (update/delete land in Phase 2)', async () => {
    const { deps } = depsWith(() => ({ rows: [], rowCount: 0 }));
    const r = await handleApiRequest(deps, reqOf('PATCH', '/authors/abc'));
    expect(r.status).toBe(405);
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

  it('maps an unexpected error to a 500', async () => {
    const { deps } = depsWith(() => {
      throw new Error('boom');
    });
    const r = await handleApiRequest(deps, reqOf('GET', '/authors'));
    expect(r.status).toBe(500);
    expect(errorOf(r.body)).toEqual({ code: 'internal', message: 'boom' });
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
    expect(p.filters).toEqual({ status: 'active', kind: 'x' });
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
