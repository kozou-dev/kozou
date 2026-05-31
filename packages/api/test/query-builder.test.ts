import { describe, it, expect } from 'vitest';
import {
  buildListQuery,
  buildGetQuery,
  buildInsertQuery,
  buildUpdateQuery,
  buildDeleteQuery,
  buildRelationOptionsQuery,
  quoteIdent,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  DEFAULT_RELATION_LIMIT,
  MAX_RELATION_LIMIT,
} from '../src/query-builder.js';
import { KozouApiError } from '../src/errors.js';
import { col, tableResource, viewResource } from './helpers.js';

const authors = tableResource('authors', [
  col('id', 'uuid', { isPrimaryKey: true, nullable: false }),
  col('display_name', 'text'),
  col('bio', 'textarea'),
  col('rank', 'number'),
]);

describe('quoteIdent', () => {
  it('wraps in double quotes and escapes embedded quotes', () => {
    expect(quoteIdent('display_name')).toBe('"display_name"');
    expect(quoteIdent('a"b')).toBe('"a""b"');
  });
});

describe('buildListQuery', () => {
  it('builds a default list query ordered by the primary key', () => {
    const q = buildListQuery(authors, {});
    expect(q.dataText).toContain('FROM "public"."authors"');
    expect(q.dataText).toContain('"display_name"');
    expect(q.dataText).toContain('ORDER BY "id" ASC');
    expect(q.dataText).toContain('LIMIT $1 OFFSET $2');
    expect(q.dataText).not.toContain('WHERE');
    expect(q.dataValues).toEqual([DEFAULT_PAGE_SIZE, 0]);
    expect(q.countText).toBe('SELECT count(*) AS total FROM "public"."authors"');
    expect(q.countValues).toEqual([]);
    expect(q.page).toBe(1);
    expect(q.pageSize).toBe(DEFAULT_PAGE_SIZE);
  });

  it('applies column-equality filters as bound parameters', () => {
    const q = buildListQuery(authors, { filters: { display_name: 'Ada' } });
    expect(q.dataText).toContain('WHERE "display_name" = $1');
    expect(q.dataText).toContain('LIMIT $2 OFFSET $3');
    expect(q.dataValues).toEqual(['Ada', DEFAULT_PAGE_SIZE, 0]);
    expect(q.countText).toContain('WHERE "display_name" = $1');
    expect(q.countValues).toEqual(['Ada']);
  });

  it('searches across text/textarea columns only, reusing one placeholder', () => {
    const q = buildListQuery(authors, { search: 'lov' });
    expect(q.dataText).toContain('("display_name" ILIKE $1 OR "bio" ILIKE $1)');
    expect(q.dataValues).toEqual(['%lov%', DEFAULT_PAGE_SIZE, 0]);
  });

  it('skips search when the resource has no text-like columns', () => {
    const numeric = tableResource('m', [
      col('id', 'uuid', { isPrimaryKey: true }),
      col('amount', 'number'),
    ]);
    const q = buildListQuery(numeric, { search: 'x' });
    expect(q.dataText).not.toContain('ILIKE');
    expect(q.dataText).not.toContain('WHERE');
  });

  it('combines filters and search with AND', () => {
    const q = buildListQuery(authors, { filters: { rank: '1' }, search: 'lov' });
    expect(q.dataText).toContain('WHERE "rank" = $1 AND ("display_name" ILIKE $2 OR "bio" ILIKE $2)');
    expect(q.dataValues).toEqual(['1', '%lov%', DEFAULT_PAGE_SIZE, 0]);
  });

  it('honours explicit multi-column sort', () => {
    const q = buildListQuery(authors, {
      sort: [
        { field: 'display_name', order: 'desc' },
        { field: 'rank', order: 'asc' },
      ],
    });
    expect(q.dataText).toContain('ORDER BY "display_name" DESC, "rank" ASC');
  });

  it('omits ORDER BY for a view with no primary key and no sort', () => {
    const v = viewResource('vw', [col('a', 'text')]);
    const q = buildListQuery(v, {});
    expect(q.dataText).not.toContain('ORDER BY');
  });

  it('clamps pagination (page floor, pageSize cap, defaults)', () => {
    expect(buildListQuery(authors, { page: 0 }).page).toBe(1);
    expect(buildListQuery(authors, { pageSize: 0 }).pageSize).toBe(DEFAULT_PAGE_SIZE);
    expect(buildListQuery(authors, { pageSize: 9999 }).pageSize).toBe(MAX_PAGE_SIZE);
    const q = buildListQuery(authors, { page: 3, pageSize: 10 });
    expect(q.dataValues).toEqual([10, 20]); // offset = (3-1)*10
  });

  it('rejects an unknown filter column with a 400', () => {
    try {
      buildListQuery(authors, { filters: { bogus: '1' } });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(KozouApiError);
      expect((err as KozouApiError).status).toBe(400);
      expect((err as KozouApiError).message).toMatch(/Unknown filter column "bogus"/);
    }
  });

  it('rejects an unknown sort column with a 400', () => {
    expect(() => buildListQuery(authors, { sort: [{ field: 'bogus', order: 'asc' }] })).toThrow(
      /Unknown sort column "bogus"/,
    );
  });
});

describe('buildGetQuery', () => {
  it('builds a fetch-by-id query against the single-column primary key', () => {
    const q = buildGetQuery(authors, 'abc');
    expect(q.text).toBe(
      'SELECT "id", "display_name", "bio", "rank" FROM "public"."authors" WHERE "id" = $1 LIMIT 1',
    );
    expect(q.values).toEqual(['abc']);
  });

  it('rejects a composite primary key', () => {
    const composite = tableResource('cp', [col('a', 'text'), col('b', 'text')], ['a', 'b']);
    expect(() => buildGetQuery(composite, '1')).toThrow(/single-column primary key/);
  });

  it('rejects a view (no primary key)', () => {
    const v = viewResource('vw', [col('a', 'text')]);
    expect(() => buildGetQuery(v, '1')).toThrow(/single-column primary key/);
  });
});

describe('buildInsertQuery', () => {
  it('inserts the supplied columns as bound parameters and RETURNs the row', () => {
    const q = buildInsertQuery(authors, { display_name: 'Ada', rank: 1 });
    expect(q.text).toBe(
      'INSERT INTO "public"."authors" ("display_name", "rank") VALUES ($1, $2) RETURNING "id", "display_name", "bio", "rank"',
    );
    expect(q.values).toEqual(['Ada', 1]);
  });

  it('uses DEFAULT VALUES for an empty body', () => {
    const q = buildInsertQuery(authors, {});
    expect(q.text).toBe(
      'INSERT INTO "public"."authors" DEFAULT VALUES RETURNING "id", "display_name", "bio", "rank"',
    );
    expect(q.values).toEqual([]);
  });

  it('rejects an unknown column', () => {
    expect(() => buildInsertQuery(authors, { bogus: 1 })).toThrow(/Unknown column "bogus"/);
  });
});

describe('buildUpdateQuery', () => {
  it('sets the supplied columns and matches on the primary key', () => {
    const q = buildUpdateQuery(authors, 'abc', { display_name: 'Ada2', rank: 2 });
    expect(q.text).toBe(
      'UPDATE "public"."authors" SET "display_name" = $1, "rank" = $2 WHERE "id" = $3 RETURNING "id", "display_name", "bio", "rank"',
    );
    expect(q.values).toEqual(['Ada2', 2, 'abc']);
  });

  it('rejects an empty update', () => {
    expect(() => buildUpdateQuery(authors, 'abc', {})).toThrow(/No fields to update/);
  });

  it('rejects an unknown column', () => {
    expect(() => buildUpdateQuery(authors, 'abc', { bogus: 1 })).toThrow(/Unknown column "bogus"/);
  });

  it('rejects a resource without a single-column primary key', () => {
    const composite = tableResource('cp', [col('a', 'text'), col('b', 'text')], ['a', 'b']);
    expect(() => buildUpdateQuery(composite, '1', { a: 'x' })).toThrow(/single-column primary key/);
  });
});

describe('buildDeleteQuery', () => {
  it('deletes by primary key and RETURNs the row', () => {
    const q = buildDeleteQuery(authors, 'abc');
    expect(q.text).toBe(
      'DELETE FROM "public"."authors" WHERE "id" = $1 RETURNING "id", "display_name", "bio", "rank"',
    );
    expect(q.values).toEqual(['abc']);
  });

  it('rejects a resource without a single-column primary key', () => {
    const v = viewResource('vw', [col('a', 'text')]);
    expect(() => buildDeleteQuery(v, '1')).toThrow(/single-column primary key/);
  });
});

describe('buildRelationOptionsQuery', () => {
  it('searches the given fields and selects pk + label', () => {
    const q = buildRelationOptionsQuery(authors, {
      labelField: 'display_name',
      searchFields: ['display_name', 'bio'],
      query: 'ad',
    });
    expect(q.text).toBe(
      'SELECT "id", "display_name" FROM "public"."authors" WHERE ("display_name" ILIKE $1 OR "bio" ILIKE $1) LIMIT $2',
    );
    expect(q.values).toEqual(['%ad%', DEFAULT_RELATION_LIMIT]);
    expect(q.primaryKey).toBe('id');
    expect(q.labelField).toBe('display_name');
  });

  it('omits the WHERE clause when no query is given', () => {
    const q = buildRelationOptionsQuery(authors, { labelField: 'display_name', searchFields: [] });
    expect(q.text).toBe('SELECT "id", "display_name" FROM "public"."authors" LIMIT $1');
    expect(q.values).toEqual([DEFAULT_RELATION_LIMIT]);
  });

  it('clamps the limit and selects a single column when label === pk', () => {
    const capped = buildRelationOptionsQuery(authors, {
      labelField: 'display_name',
      searchFields: [],
      limit: 9999,
    });
    expect(capped.values).toEqual([MAX_RELATION_LIMIT]);

    const labelIsPk = buildRelationOptionsQuery(authors, { labelField: 'id', searchFields: [] });
    expect(labelIsPk.text).toBe('SELECT "id" FROM "public"."authors" LIMIT $1');
  });

  it('rejects an unknown label column', () => {
    expect(() =>
      buildRelationOptionsQuery(authors, { labelField: 'bogus', searchFields: [] }),
    ).toThrow(/Unknown column "bogus"/);
  });
});
