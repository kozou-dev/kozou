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
import type { EmbedNode } from '../src/embed.js';
import { col, tableResource, viewResource, relation } from './helpers.js';

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
    const q = buildListQuery(authors, {
      filters: [{ column: 'display_name', op: 'eq', value: 'Ada' }],
    });
    expect(q.dataText).toContain('WHERE "display_name" = $1');
    expect(q.dataText).toContain('LIMIT $2 OFFSET $3');
    expect(q.dataValues).toEqual(['Ada', DEFAULT_PAGE_SIZE, 0]);
    expect(q.countText).toContain('WHERE "display_name" = $1');
    expect(q.countValues).toEqual(['Ada']);
  });

  it('maps each comparison operator to its SQL and binds the value', () => {
    const cases: { op: 'neq' | 'gt' | 'gte' | 'lt' | 'lte'; sql: string }[] = [
      { op: 'neq', sql: '<>' },
      { op: 'gt', sql: '>' },
      { op: 'gte', sql: '>=' },
      { op: 'lt', sql: '<' },
      { op: 'lte', sql: '<=' },
    ];
    for (const { op, sql } of cases) {
      const q = buildListQuery(authors, { filters: [{ column: 'rank', op, value: '5' }] });
      expect(q.dataText).toContain(`WHERE "rank" ${sql} $1`);
      expect(q.dataValues).toEqual(['5', DEFAULT_PAGE_SIZE, 0]);
      expect(q.countValues).toEqual(['5']);
    }
  });

  it('LIKE / ILIKE translate `*` wildcards to `%` and bind the pattern', () => {
    const like = buildListQuery(authors, {
      filters: [{ column: 'display_name', op: 'like', value: 'Ada*' }],
    });
    expect(like.dataText).toContain('WHERE "display_name" LIKE $1');
    expect(like.dataValues[0]).toBe('Ada%');

    const ilike = buildListQuery(authors, {
      filters: [{ column: 'display_name', op: 'ilike', value: '*love*' }],
    });
    expect(ilike.dataText).toContain('WHERE "display_name" ILIKE $1');
    expect(ilike.dataValues[0]).toBe('%love%');
  });

  it('IN expands to one bound placeholder per value', () => {
    const q = buildListQuery(authors, {
      filters: [{ column: 'display_name', op: 'in', values: ['Ada', 'Grace'] }],
    });
    expect(q.dataText).toContain('WHERE "display_name" IN ($1, $2)');
    expect(q.dataText).toContain('LIMIT $3 OFFSET $4');
    expect(q.dataValues).toEqual(['Ada', 'Grace', DEFAULT_PAGE_SIZE, 0]);
    expect(q.countValues).toEqual(['Ada', 'Grace']);
  });

  it('rejects an empty IN list with a 400', () => {
    expect(() =>
      buildListQuery(authors, { filters: [{ column: 'display_name', op: 'in', values: [] }] }),
    ).toThrow(/needs at least one value/);
  });

  it('IS emits a fixed keyword clause with no bound value', () => {
    const nul = buildListQuery(authors, {
      filters: [{ column: 'rank', op: 'is', keyword: 'null' }],
    });
    expect(nul.dataText).toContain('WHERE "rank" IS NULL');
    expect(nul.dataValues).toEqual([DEFAULT_PAGE_SIZE, 0]); // no filter value bound

    const notnull = buildListQuery(authors, {
      filters: [{ column: 'rank', op: 'is', keyword: 'notnull' }],
    });
    expect(notnull.dataText).toContain('WHERE "rank" IS NOT NULL');

    // is.true / is.false require a boolean column (see the #76 type-check test).
    const flags = tableResource('flags', [
      col('id', 'uuid', { isPrimaryKey: true, nullable: false }),
      col('active', 'boolean', { dataType: 'boolean' }),
    ]);
    const isTrue = buildListQuery(flags, {
      filters: [{ column: 'active', op: 'is', keyword: 'true' }],
    });
    expect(isTrue.dataText).toContain('WHERE "active" IS TRUE');

    const isFalse = buildListQuery(flags, {
      filters: [{ column: 'active', op: 'is', keyword: 'false' }],
    });
    expect(isFalse.dataText).toContain('WHERE "active" IS FALSE');
  });

  it('rejects an operator that is incompatible with the column type (400)', () => {
    // ILIKE / LIKE need a text-like column.
    const numbers = tableResource('numbers', [
      col('id', 'uuid', { isPrimaryKey: true, nullable: false }),
      col('amount', 'currency', { dataType: 'numeric' }),
    ]);
    expect(() =>
      buildListQuery(numbers, {
        filters: [{ column: 'amount', op: 'ilike', value: '*5*' }],
      }),
    ).toThrow(/requires a text-like column/);

    // is.true / is.false need a boolean column.
    expect(() =>
      buildListQuery(authors, {
        filters: [{ column: 'display_name', op: 'is', keyword: 'true' }],
      }),
    ).toThrow(/requires a boolean column/);

    // The same check carries the 400 status.
    try {
      buildListQuery(numbers, { filters: [{ column: 'amount', op: 'like', value: 'x' }] });
      expect.unreachable('expected a 400');
    } catch (err) {
      expect(err).toBeInstanceOf(KozouApiError);
      expect((err as KozouApiError).status).toBe(400);
    }
  });

  it('treats array type spellings as non-text for LIKE/ILIKE (not scalar targets)', () => {
    const arrays = tableResource('arrays', [
      col('id', 'uuid', { isPrimaryKey: true, nullable: false }),
      col('tags', 'text', { dataType: 'text[]' }),
      col('names', 'text', { dataType: 'character varying[]' }),
      col('flags', 'boolean', { dataType: 'boolean[]' }),
    ]);
    expect(() =>
      buildListQuery(arrays, { filters: [{ column: 'tags', op: 'ilike', value: '*x*' }] }),
    ).toThrow(/requires a text-like column/);
    expect(() =>
      buildListQuery(arrays, { filters: [{ column: 'names', op: 'like', value: 'x' }] }),
    ).toThrow(/requires a text-like column/);
    expect(() =>
      buildListQuery(arrays, { filters: [{ column: 'flags', op: 'is', keyword: 'true' }] }),
    ).toThrow(/requires a boolean column/);
  });

  it('strips length/precision modifiers when judging text-likeness', () => {
    const sized = tableResource('sized', [
      col('id', 'uuid', { isPrimaryKey: true, nullable: false }),
      col('code', 'text', { dataType: 'character varying(255)' }),
    ]);
    expect(() =>
      buildListQuery(sized, { filters: [{ column: 'code', op: 'ilike', value: '*x*' }] }),
    ).not.toThrow();
  });

  it('rejects a filter value that cannot parse as the column type (400, pre-execution) (#76)', () => {
    const t = tableResource('t', [
      col('id', 'uuid', { isPrimaryKey: true, nullable: false }),
      col('amount', 'currency', { dataType: 'numeric' }),
      col('count', 'number', { dataType: 'integer' }),
      col('active', 'boolean', { dataType: 'boolean' }),
    ]);
    // Non-numeric value on a numeric column (the issue's headline case).
    expect(() =>
      buildListQuery(t, { filters: [{ column: 'amount', op: 'eq', value: 'abc' }] }),
    ).toThrow(/is not valid for column "amount"/);
    // A bad value inside in.() is caught too.
    expect(() =>
      buildListQuery(t, { filters: [{ column: 'amount', op: 'in', values: ['1', 'two'] }] }),
    ).toThrow(/is not valid for column "amount"/);
    // Integer column rejects a fractional value.
    expect(() =>
      buildListQuery(t, { filters: [{ column: 'count', op: 'gt', value: '1.5' }] }),
    ).toThrow(/is not valid for column "count"/);
    // Boolean column rejects a non-boolean literal.
    expect(() =>
      buildListQuery(t, { filters: [{ column: 'active', op: 'eq', value: 'maybe' }] }),
    ).toThrow(/is not valid for column "active"/);
    // Hex/binary literals that JS Number() tolerates but PostgreSQL rejects.
    expect(() =>
      buildListQuery(t, { filters: [{ column: 'amount', op: 'eq', value: '0x10' }] }),
    ).toThrow(/is not valid for column "amount"/);
    expect(() =>
      buildListQuery(t, { filters: [{ column: 'count', op: 'eq', value: '0b101' }] }),
    ).toThrow(/is not valid for column "count"/);
    // Integer value outside the column width's range.
    expect(() =>
      buildListQuery(t, { filters: [{ column: 'count', op: 'eq', value: '9999999999' }] }),
    ).toThrow(/is not valid for column "count"/);
    // The check carries the 400 status.
    try {
      buildListQuery(t, { filters: [{ column: 'amount', op: 'eq', value: 'abc' }] });
      expect.unreachable('expected a 400');
    } catch (err) {
      expect((err as KozouApiError).status).toBe(400);
    }
  });

  it('accepts well-formed values for numeric / integer / boolean columns', () => {
    const t = tableResource('t', [
      col('id', 'uuid', { isPrimaryKey: true, nullable: false }),
      col('amount', 'currency', { dataType: 'numeric' }),
      col('count', 'number', { dataType: 'integer' }),
      col('active', 'boolean', { dataType: 'boolean' }),
    ]);
    expect(() =>
      buildListQuery(t, { filters: [{ column: 'amount', op: 'gte', value: '42.50' }] }),
    ).not.toThrow();
    // Scientific notation is valid PostgreSQL numeric input.
    expect(() =>
      buildListQuery(t, { filters: [{ column: 'amount', op: 'lt', value: '1e3' }] }),
    ).not.toThrow();
    // Arbitrary-precision numeric beyond JS Number range is still valid (the
    // check is lexical, not a JS Number coercion).
    expect(() =>
      buildListQuery(t, {
        filters: [{ column: 'amount', op: 'eq', value: '123456789012345678901234567890.12' }],
      }),
    ).not.toThrow();
    // Negative integer within range.
    expect(() =>
      buildListQuery(t, { filters: [{ column: 'count', op: 'eq', value: '-7' }] }),
    ).not.toThrow();
    expect(() =>
      buildListQuery(t, { filters: [{ column: 'count', op: 'eq', value: '7' }] }),
    ).not.toThrow();
    expect(() =>
      buildListQuery(t, { filters: [{ column: 'active', op: 'eq', value: 'true' }] }),
    ).not.toThrow();
    // A non-numeric column does not get value-checked here (text passes through).
    expect(() =>
      buildListQuery(t, { filters: [{ column: 'id', op: 'eq', value: 'anything' }] }),
    ).not.toThrow();
  });

  it('free-text search skips a text-widget column whose underlying type is non-text (text[])', () => {
    const r = tableResource('docs', [
      col('id', 'uuid', { isPrimaryKey: true, nullable: false }),
      col('title', 'text', { dataType: 'text' }),
      col('tags', 'text', { dataType: 'text[]' }), // text widget, array type
    ]);
    const q = buildListQuery(r, { search: 'foo' });
    expect(q.dataText).toContain('"title" ILIKE');
    expect(q.dataText).not.toContain('"tags" ILIKE'); // array column is not ILIKE'd
  });

  it('allows a type-compatible operator (ilike on text, is.true on boolean)', () => {
    const ok = tableResource('rec', [
      col('id', 'uuid', { isPrimaryKey: true, nullable: false }),
      col('name', 'text', { dataType: 'character varying' }),
      col('active', 'boolean', { dataType: 'boolean' }),
    ]);
    expect(() =>
      buildListQuery(ok, { filters: [{ column: 'name', op: 'ilike', value: '*a*' }] }),
    ).not.toThrow();
    expect(() =>
      buildListQuery(ok, { filters: [{ column: 'active', op: 'is', keyword: 'true' }] }),
    ).not.toThrow();
    // is.null / is.notnull stay valid on any type.
    expect(() =>
      buildListQuery(ok, { filters: [{ column: 'name', op: 'is', keyword: 'null' }] }),
    ).not.toThrow();
  });

  it('ANDs several filters on the same column (e.g. a range) with stable $n', () => {
    const q = buildListQuery(authors, {
      filters: [
        { column: 'rank', op: 'gte', value: '10' },
        { column: 'rank', op: 'lte', value: '20' },
      ],
    });
    expect(q.dataText).toContain('WHERE "rank" >= $1 AND "rank" <= $2');
    expect(q.dataValues).toEqual(['10', '20', DEFAULT_PAGE_SIZE, 0]);
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
    const q = buildListQuery(authors, {
      filters: [{ column: 'rank', op: 'eq', value: '1' }],
      search: 'lov',
    });
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
      buildListQuery(authors, { filters: [{ column: 'bogus', op: 'eq', value: '1' }] });
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

  it('builds a fetch-by-id query against a composite primary key', () => {
    const composite = tableResource('cp', [col('a', 'text'), col('b', 'text')], ['a', 'b']);
    const q = buildGetQuery(composite, 'x,y');
    expect(q.text).toBe(
      'SELECT "a", "b" FROM "public"."cp" WHERE "a" = $1 AND "b" = $2 LIMIT 1',
    );
    expect(q.values).toEqual(['x', 'y']);
  });

  it('rejects a composite id with the wrong number of components (400)', () => {
    const composite = tableResource('cp', [col('a', 'text'), col('b', 'text')], ['a', 'b']);
    try {
      buildGetQuery(composite, 'only-one');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(KozouApiError);
      expect((err as KozouApiError).status).toBe(400);
      expect((err as KozouApiError).message).toMatch(/composite primary key.*expected 2/);
    }
  });

  it('does not split a single-column key, so a comma in the value is preserved', () => {
    const q = buildGetQuery(authors, 'a,b');
    expect(q.text).toContain('WHERE "id" = $1 LIMIT 1');
    expect(q.values).toEqual(['a,b']);
  });

  it('rejects a view (no primary key)', () => {
    const v = viewResource('vw', [col('a', 'text')]);
    expect(() => buildGetQuery(v, '1')).toThrow(/no primary key/);
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

  it('matches on every column of a composite primary key', () => {
    const composite = tableResource(
      'cp',
      [col('a', 'text'), col('b', 'text'), col('note', 'text')],
      ['a', 'b'],
    );
    const q = buildUpdateQuery(composite, 'x,y', { note: 'hi' });
    expect(q.text).toBe(
      'UPDATE "public"."cp" SET "note" = $1 WHERE "a" = $2 AND "b" = $3 RETURNING "a", "b", "note"',
    );
    expect(q.values).toEqual(['hi', 'x', 'y']);
  });

  it('rejects a PK-less resource (400)', () => {
    const v = viewResource('vw', [col('a', 'text')]);
    expect(() => buildUpdateQuery(v, '1', { a: 'x' })).toThrow(/no primary key/);
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

  it('deletes by every column of a composite primary key', () => {
    const composite = tableResource('cp', [col('a', 'text'), col('b', 'text')], ['a', 'b']);
    const q = buildDeleteQuery(composite, 'x,y');
    expect(q.text).toBe(
      'DELETE FROM "public"."cp" WHERE "a" = $1 AND "b" = $2 RETURNING "a", "b"',
    );
    expect(q.values).toEqual(['x', 'y']);
  });

  it('rejects a PK-less resource (400)', () => {
    const v = viewResource('vw', [col('a', 'text')]);
    expect(() => buildDeleteQuery(v, '1')).toThrow(/no primary key/);
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

  it('rejects a non-text-like relation search field with 400 (#76)', () => {
    const r = tableResource('opts', [
      col('id', 'uuid', { isPrimaryKey: true, nullable: false }),
      col('name', 'text', { dataType: 'text' }),
      col('amount', 'currency', { dataType: 'numeric' }),
    ]);
    try {
      buildRelationOptionsQuery(r, { labelField: 'name', searchFields: ['amount'], query: 'x' });
      expect.unreachable('expected a 400');
    } catch (err) {
      expect(err).toBeInstanceOf(KozouApiError);
      expect((err as KozouApiError).status).toBe(400);
      expect((err as KozouApiError).message).toMatch(/must be a text-like column/);
    }
    // A text search field is accepted.
    expect(() =>
      buildRelationOptionsQuery(r, { labelField: 'name', searchFields: ['name'], query: 'x' }),
    ).not.toThrow();
  });
});

describe('embed in read queries', () => {
  const books = tableResource('books', [
    col('id', 'uuid', { isPrimaryKey: true }),
    col('author_id', 'uuid'),
    col('title', 'text'),
  ]);
  const authorsTarget = tableResource('authors', [
    col('id', 'uuid', { isPrimaryKey: true }),
    col('display_name', 'text'),
  ]);
  const embedAuthors: EmbedNode[] = [
    {
      kind: 'to-one',
      relation: relation('author_id', 'authors'),
      target: authorsTarget,
      key: 'authors',
      children: [],
    },
  ];

  it('splices an embed fragment into the list SELECT and keeps limit/offset params', () => {
    const q = buildListQuery(books, { embed: embedAuthors });
    expect(q.dataText).toContain('AS "authors"');
    expect(q.dataText).toContain('to_jsonb(e1)');
    expect(q.dataText).toContain('LIMIT $1 OFFSET $2');
  });

  it('keeps $n numbering when embed combines with a filter and search', () => {
    const q = buildListQuery(books, {
      filters: [{ column: 'author_id', op: 'eq', value: 'x' }],
      search: 'foo',
      embed: embedAuthors,
    });
    expect(q.dataText).toContain('WHERE "author_id" = $1 AND ("title" ILIKE $2)');
    expect(q.dataText).toContain('LIMIT $3 OFFSET $4');
    expect(q.dataValues).toEqual(['x', '%foo%', DEFAULT_PAGE_SIZE, 0]);
  });

  it('leaves the count query untouched when embedding', () => {
    const q = buildListQuery(books, { embed: embedAuthors });
    expect(q.countText).toBe('SELECT count(*) AS total FROM "public"."books"');
    expect(q.countValues).toEqual([]);
  });

  it('splices an embed fragment into the by-id query and keeps $1', () => {
    const q = buildGetQuery(books, 'abc', embedAuthors);
    expect(q.text).toContain('AS "authors"');
    expect(q.text).toContain('WHERE "id" = $1 LIMIT 1');
    expect(q.values).toEqual(['abc']);
  });

  it('splices a reverse to-many aggregate capped at MAX_EMBED_CHILDREN', () => {
    const childBooks = tableResource('books', [
      col('id', 'uuid', { isPrimaryKey: true }),
      col('author_id', 'uuid'),
    ]);
    const embedBooks: EmbedNode[] = [
      {
        kind: 'to-many',
        relation: relation('author_id', 'authors'),
        target: childBooks,
        key: 'books',
        children: [],
      },
    ];
    const q = buildListQuery(authors, { embed: embedBooks });
    expect(q.dataText).toContain('jsonb_agg');
    expect(q.dataText).toContain('AS "books"');
    expect(q.dataText).toContain('LIMIT 100');
    // outer pagination stays parameterized
    expect(q.dataText).toContain('LIMIT $1 OFFSET $2');
    expect(q.countText).toBe('SELECT count(*) AS total FROM "public"."authors"');
  });
});
