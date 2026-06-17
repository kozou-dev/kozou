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

// A well-formed uuid for the `authors` / `books` fixtures, whose primary key is
// a uuid: an id segment is now pre-flighted against the key type (#110), so a
// throwaway id like 'abc' would (correctly) 400 before the SQL is built.
const SAMPLE_UUID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';

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
    expect(q.dataValues).toEqual([DEFAULT_PAGE_SIZE + 1, 0]);
    expect(q.countText).toBe('SELECT count(*) AS total FROM "public"."authors"');
    expect(q.countValues).toEqual([]);
    expect(q.page).toBe(1);
    expect(q.pageSize).toBe(DEFAULT_PAGE_SIZE);
  });

  it('defaults the count mode to exact when none is given (#177)', () => {
    expect(buildListQuery(authors, {}).countMode).toBe('exact');
  });

  it('count=none sets the mode to none (the handler then skips counting) (#177)', () => {
    expect(buildListQuery(authors, { count: 'none' }).countMode).toBe('none');
  });

  it('count=estimated builds an EXPLAIN over the same filtered set, no ORDER/LIMIT (#177)', () => {
    const q = buildListQuery(authors, {
      count: 'estimated',
      filters: [{ column: 'display_name', op: 'eq', value: 'Ada' }],
    });
    expect(q.countMode).toBe('estimated');
    expect(q.estimateText).toBe(
      'EXPLAIN (FORMAT JSON) SELECT 1 FROM "public"."authors" WHERE "display_name" = $1',
    );
    expect(q.countValues).toEqual(['Ada']);
    expect(q.estimateText).not.toMatch(/ORDER BY|LIMIT|OFFSET/);
    // The exact count query is still built (kept for back-compat) over the
    // same filter, even though estimated mode does not run it.
    expect(q.countText).toBe(
      'SELECT count(*) AS total FROM "public"."authors" WHERE "display_name" = $1',
    );
  });

  // ---- Keyset (cursor) pagination (#185) ----
  const cursorFor = (
    order: { field: string; order: 'asc' | 'desc' }[],
    values: unknown[],
  ) => ({ order, values });

  const ranked = tableResource('ranked', [
    col('id', 'uuid', { isPrimaryKey: true, nullable: false }),
    col('score', 'number', { nullable: true, dataType: 'integer' }),
  ]);
  const orderLines = tableResource(
    'order_lines',
    [
      col('order_id', 'number', { isPrimaryKey: true, nullable: false, dataType: 'integer' }),
      col('line_no', 'number', { isPrimaryKey: true, nullable: false, dataType: 'integer' }),
      col('product', 'text'),
    ],
    ['order_id', 'line_no'],
  );

  it('after: keyset predicate on a single non-null PK, LIMIT only, no OFFSET (#185)', () => {
    const q = buildListQuery(authors, { after: cursorFor([{ field: 'id', order: 'asc' }], [SAMPLE_UUID]) });
    expect(q.dataText).toContain('WHERE "id" > $1');
    expect(q.dataText).toContain('ORDER BY "id" ASC');
    expect(q.dataText).toContain('LIMIT $2');
    expect(q.dataText).not.toContain('OFFSET');
    expect(q.dataValues).toEqual([SAMPLE_UUID, DEFAULT_PAGE_SIZE + 1]);
    expect(q.reverseRows).toBe(false);
    expect(q.orderKey).toEqual([{ field: 'id', order: 'asc' }]);
    // total is still the full filtered count (the keyset boundary is excluded).
    expect(q.countText).toBe('SELECT count(*) AS total FROM "public"."authors"');
    expect(q.countValues).toEqual([]);
  });

  it('before: walks the reversed order and flags reverseRows (#185)', () => {
    const q = buildListQuery(authors, { before: cursorFor([{ field: 'id', order: 'asc' }], [SAMPLE_UUID]) });
    expect(q.dataText).toContain('WHERE "id" < $1');
    expect(q.dataText).toContain('ORDER BY "id" DESC');
    expect(q.dataText).not.toContain('OFFSET');
    expect(q.reverseRows).toBe(true);
    // orderKey stays the forward order (used to encode the response cursors).
    expect(q.orderKey).toEqual([{ field: 'id', order: 'asc' }]);
  });

  it('after: composite PK expands lexicographically (#185)', () => {
    const q = buildListQuery(orderLines, {
      after: cursorFor(
        [
          { field: 'order_id', order: 'asc' },
          { field: 'line_no', order: 'asc' },
        ],
        [5, 3],
      ),
    });
    expect(q.dataText).toContain(
      'WHERE ("order_id" > $1 OR ("order_id" = $2 AND "line_no" > $3))',
    );
    expect(q.dataValues).toEqual([5, 5, 3, DEFAULT_PAGE_SIZE + 1]);
  });

  it('mixed asc/desc with a nullable sort column, non-null boundary (#185)', () => {
    const q = buildListQuery(ranked, {
      sort: [{ field: 'score', order: 'desc' }],
      after: cursorFor(
        [
          { field: 'score', order: 'desc' },
          { field: 'id', order: 'asc' },
        ],
        [50, SAMPLE_UUID],
      ),
    });
    expect(q.dataText).toContain('WHERE ("score" < $1 OR ("score" = $2 AND "id" > $3))');
    expect(q.dataText).toContain('ORDER BY "score" DESC, "id" ASC');
    expect(q.dataValues).toEqual([50, 50, SAMPLE_UUID, DEFAULT_PAGE_SIZE + 1]);
  });

  it('nullable DESC sort column with a NULL boundary honors NULLS FIRST (#185)', () => {
    const q = buildListQuery(ranked, {
      sort: [{ field: 'score', order: 'desc' }],
      after: cursorFor(
        [
          { field: 'score', order: 'desc' },
          { field: 'id', order: 'asc' },
        ],
        [null, SAMPLE_UUID],
      ),
    });
    // DESC + NULL boundary: every non-NULL follows the leading NULL group; then
    // within the NULL group, order by id.
    expect(q.dataText).toContain('WHERE ("score" IS NOT NULL OR ("score" IS NULL AND "id" > $1))');
    expect(q.dataValues).toEqual([SAMPLE_UUID, DEFAULT_PAGE_SIZE + 1]);
  });

  it('nullable ASC sort column with a NULL boundary drops the dead term (#185)', () => {
    const q = buildListQuery(ranked, {
      sort: [{ field: 'score', order: 'asc' }],
      after: cursorFor(
        [
          { field: 'score', order: 'asc' },
          { field: 'id', order: 'asc' },
        ],
        [null, SAMPLE_UUID],
      ),
    });
    // ASC + NULL boundary: nothing follows a NULL (NULLS LAST), so the leading
    // term is dropped; remaining rows are the same NULL group ordered by id.
    expect(q.dataText).toContain('WHERE ("score" IS NULL AND "id" > $1)');
    expect(q.dataValues).toEqual([SAMPLE_UUID, DEFAULT_PAGE_SIZE + 1]);
  });

  it('rejects after + before together (400) (#185)', () => {
    expect(() =>
      buildListQuery(authors, {
        after: cursorFor([{ field: 'id', order: 'asc' }], ['a']),
        before: cursorFor([{ field: 'id', order: 'asc' }], ['b']),
      }),
    ).toThrow(/only one of "after" or "before"/);
  });

  it('rejects a cursor on a primary-key-less resource (400) (#185)', () => {
    const v = viewResource('vw_active', [col('id', 'uuid'), col('label', 'text')]);
    expect(() =>
      buildListQuery(v, { after: cursorFor([{ field: 'id', order: 'asc' }], ['a']) }),
    ).toThrow(/needs a primary key/);
  });

  it('rejects a cursor combined with page > 1 (400) (#185)', () => {
    expect(() =>
      buildListQuery(authors, { page: 2, after: cursorFor([{ field: 'id', order: 'asc' }], ['a']) }),
    ).toThrow(/cannot be combined with page/);
  });

  it('rejects a cursor whose order does not match the current sort (400) (#185)', () => {
    expect(() =>
      buildListQuery(authors, { after: cursorFor([{ field: 'id', order: 'desc' }], ['a']) }),
    ).toThrow(/does not match the current sort/);
  });

  it('rejects a cursor whose boundary value is invalid for the column type (400) (#185)', () => {
    // Shape-valid in the cursor but not a parseable uuid for the PK — pre-flighted
    // to a 400 instead of reaching PostgreSQL as a 500 (a forged/tampered cursor).
    expect(() =>
      buildListQuery(authors, {
        after: cursorFor([{ field: 'id', order: 'asc' }], ['not-a-uuid']),
      }),
    ).toThrow(/is not valid for column "id"/);
  });

  it('cursor key aliases never collide with a real column of the same name (#185)', () => {
    // A (pathological) column literally named like the private cursor alias: the
    // alias namespace is lengthened so the real column is still selected and is
    // not dropped by the handler's alias stripping.
    const weird = tableResource(
      '__cursors',
      [col('__kozou_cursor_0', 'number', { isPrimaryKey: true, nullable: false, dataType: 'integer' })],
      ['__kozou_cursor_0'],
    );
    const q = buildListQuery(weird, {});
    expect(q.cursorKeyAliases).toEqual(['__kozou_cursor__0']);
    expect(q.dataText).toContain('"__kozou_cursor_0"::text AS "__kozou_cursor__0"');
  });

  it('applies column-equality filters as bound parameters', () => {
    const q = buildListQuery(authors, {
      filters: [{ column: 'display_name', op: 'eq', value: 'Ada' }],
    });
    expect(q.dataText).toContain('WHERE "display_name" = $1');
    expect(q.dataText).toContain('LIMIT $2 OFFSET $3');
    expect(q.dataValues).toEqual(['Ada', DEFAULT_PAGE_SIZE + 1, 0]);
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
      expect(q.dataValues).toEqual(['5', DEFAULT_PAGE_SIZE + 1, 0]);
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
    expect(q.dataValues).toEqual(['Ada', 'Grace', DEFAULT_PAGE_SIZE + 1, 0]);
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
    expect(nul.dataValues).toEqual([DEFAULT_PAGE_SIZE + 1, 0]); // no filter value bound

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

  it('accepts well-formed values for numeric / integer / boolean / uuid columns', () => {
    const t = tableResource('t', [
      col('id', 'uuid', { isPrimaryKey: true, nullable: false }),
      col('amount', 'currency', { dataType: 'numeric' }),
      col('count', 'number', { dataType: 'integer' }),
      col('active', 'boolean', { dataType: 'boolean' }),
      col('note', 'text', { dataType: 'text' }),
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
    // The non-finite literals PostgreSQL accepts for the decimal/float family.
    for (const special of ['NaN', 'Infinity', '-Infinity', 'inf']) {
      expect(() =>
        buildListQuery(t, { filters: [{ column: 'amount', op: 'eq', value: special }] }),
      ).not.toThrow();
    }
    // A well-formed uuid is accepted (uuid is now a pre-flighted family, #110),
    // including the brace-wrapped form PostgreSQL accepts.
    expect(() =>
      buildListQuery(t, { filters: [{ column: 'id', op: 'eq', value: SAMPLE_UUID }] }),
    ).not.toThrow();
    expect(() =>
      buildListQuery(t, { filters: [{ column: 'id', op: 'eq', value: `{${SAMPLE_UUID}}` }] }),
    ).not.toThrow();
    // A type without a checked lexical form (text) passes through unchecked.
    expect(() =>
      buildListQuery(t, { filters: [{ column: 'note', op: 'eq', value: 'anything' }] }),
    ).not.toThrow();
  });

  it('rejects numeric(p,s) precision overflow and out-of-range floats (400, pre-execution) (#81)', () => {
    const t = tableResource('t', [
      col('id', 'uuid', { isPrimaryKey: true, nullable: false }),
      col('price', 'currency', { dataType: 'numeric(12,2)' }), // 12 total / scale 2
      col('tiny', 'number', { dataType: 'numeric(3,5)' }), // scale > precision
      col('ratio', 'number', { dataType: 'real' }),
      col('measure', 'number', { dataType: 'double precision' }),
    ]);
    // numeric(12,2): more than 12 total digits after scaling overflows.
    expect(() =>
      buildListQuery(t, { filters: [{ column: 'price', op: 'eq', value: '999999999999999999999' }] }),
    ).toThrow(/is not valid for column "price"/);
    // Exponent form that expands past the budget overflows too.
    expect(() =>
      buildListQuery(t, { filters: [{ column: 'price', op: 'eq', value: '1e20' }] }),
    ).toThrow(/is not valid for column "price"/);
    // Scale rounding carries into a new integer digit: 9999999999.995 rounds to
    // 10000000000.00 (13 digits) on numeric(12,2) — a 500 without the carry check.
    expect(() =>
      buildListQuery(t, { filters: [{ column: 'price', op: 'eq', value: '9999999999.995' }] }),
    ).toThrow(/is not valid for column "price"/);
    // numeric(3,5): a value >= 0.01 needs more than 3 total digits after scaling.
    expect(() =>
      buildListQuery(t, { filters: [{ column: 'tiny', op: 'eq', value: '0.5' }] }),
    ).toThrow(/is not valid for column "tiny"/);
    // real: a magnitude beyond ~3.4e38 is out of range.
    expect(() =>
      buildListQuery(t, { filters: [{ column: 'ratio', op: 'gt', value: '1e40' }] }),
    ).toThrow(/is not valid for column "ratio"/);
    // double precision: a magnitude beyond ~1.8e308 is out of range.
    expect(() =>
      buildListQuery(t, { filters: [{ column: 'measure', op: 'lt', value: '1e400' }] }),
    ).toThrow(/is not valid for column "measure"/);
    // Underflow: a nonzero magnitude that rounds to zero is rejected too.
    expect(() =>
      buildListQuery(t, { filters: [{ column: 'ratio', op: 'eq', value: '1e-46' }] }),
    ).toThrow(/is not valid for column "ratio"/);
    expect(() =>
      buildListQuery(t, { filters: [{ column: 'measure', op: 'eq', value: '1e-400' }] }),
    ).toThrow(/is not valid for column "measure"/);
    // The check carries the 400 status.
    try {
      buildListQuery(t, { filters: [{ column: 'price', op: 'eq', value: '1e20' }] });
      expect.unreachable('expected a 400');
    } catch (err) {
      expect((err as KozouApiError).status).toBe(400);
    }
  });

  it('matches PostgreSQL at the real (float32) rounding boundaries — single, not double, rounding (#85)', () => {
    const t = tableResource('t', [
      col('id', 'uuid', { isPrimaryKey: true, nullable: false }),
      col('ratio', 'number', { dataType: 'real' }),
    ]);
    // Exact decimals around the float32 round-to-zero threshold 2^-150 and the
    // round-to-Infinity threshold 2^128-2^103. Each accept/reject below was
    // verified against PostgreSQL 16 via pg_input_is_valid(v,'real'). The
    // previous Math.fround check double-rounded (decimal->binary64->binary32)
    // and falsely rejected the two "just inside the bound" cases.
    const TWO_POW_NEG_150 =
      '0.000000000000000000000000000000000000000000000700649232162408535461864791644958065640130970938257885878534141944895541342930300743319094181060791015625';
    // 2^-150 + 2^-205: just ABOVE the threshold but binary64 rounds it to exactly
    // 2^-150, so Math.fround flushed it to 0. PostgreSQL rounds it up to 2^-149.
    const JUST_ABOVE_UNDERFLOW =
      '0.0000000000000000000000000000000000000000000007006492321624085549087875349610259004653311390011461377230721691985428322839197219611279505416340447154525722678550529905205923597577566397376358509063720703125';
    const JUST_BELOW_UNDERFLOW =
      '0.0000000000000000000000000000000000000000000007006492321624085160149420483288902308149308028753696340339961146912482504019408795255102378204875373157974277321449470094794076402422433602623641490936279296875';
    const SMALLEST_SUBNORMAL = // 2^-149
      '0.00000000000000000000000000000000000000000000140129846432481707092372958328991613128026194187651577175706828388979108268586060148663818836212158203125';
    const OVERFLOW = '340282356779733661637539395458142568448'; // 2^128 - 2^103
    const JUST_BELOW_OVERFLOW = '340282356779733642748073463979561713664'; // OVERFLOW - 2^74
    const JUST_ABOVE_OVERFLOW = '340282356779733680527005326936723423232'; // OVERFLOW + 2^74
    const MAX_FINITE = '340282346638528859811704183484516925440'; // 2^128 - 2^104

    const accepts = (value: string): void =>
      expect(() => buildListQuery(t, { filters: [{ column: 'ratio', op: 'eq', value }] })).not.toThrow();
    const rejects = (value: string): void =>
      expect(() =>
        buildListQuery(t, { filters: [{ column: 'ratio', op: 'eq', value }] }),
      ).toThrow(/is not valid for column "ratio"/);

    // Underflow boundary 2^-150 (tie rounds to 0).
    rejects(TWO_POW_NEG_150); // exactly the tie -> 0 (underflow)
    accepts(JUST_ABOVE_UNDERFLOW); // > 2^-150 -> 2^-149 (was a false reject)
    rejects(JUST_BELOW_UNDERFLOW); // < 2^-150 -> 0 (underflow)
    accepts(SMALLEST_SUBNORMAL); // 2^-149, the smallest positive real
    // Overflow boundary 2^128-2^103 (tie rounds to Infinity).
    rejects(OVERFLOW); // exactly the tie -> Infinity (overflow)
    accepts(JUST_BELOW_OVERFLOW); // < threshold -> max finite (was a false reject)
    rejects(JUST_ABOVE_OVERFLOW); // > threshold -> Infinity (overflow)
    accepts(MAX_FINITE); // 2^128-2^104, the largest finite real
    // Sign and exponent-form variants resolve to the same magnitudes.
    accepts('-' + JUST_ABOVE_UNDERFLOW);
    rejects('-' + OVERFLOW);
    accepts('3.40282e38'); // < threshold
    rejects('3.5e38'); // > threshold
  });

  it('accepts in-range numeric(p,s) / float values and unbounded numeric (#81)', () => {
    const t = tableResource('t', [
      col('id', 'uuid', { isPrimaryKey: true, nullable: false }),
      col('price', 'currency', { dataType: 'numeric(12,2)' }),
      col('tiny', 'number', { dataType: 'numeric(3,5)' }), // scale > precision
      col('ratio', 'number', { dataType: 'real' }),
      col('unbounded', 'currency', { dataType: 'numeric' }), // no typmod
    ]);
    // Right at the 12-total-digit budget of numeric(12,2).
    expect(() =>
      buildListQuery(t, { filters: [{ column: 'price', op: 'lte', value: '1234567890.99' }] }),
    ).not.toThrow();
    // Excess scale is rounded by PostgreSQL, not rejected.
    expect(() =>
      buildListQuery(t, { filters: [{ column: 'price', op: 'eq', value: '1.23456' }] }),
    ).not.toThrow();
    // Zero fits any numeric(p,s) regardless of how the exponent shifts it.
    expect(() =>
      buildListQuery(t, { filters: [{ column: 'price', op: 'eq', value: '0e20' }] }),
    ).not.toThrow();
    expect(() =>
      buildListQuery(t, { filters: [{ column: 'price', op: 'eq', value: '0000e3' }] }),
    ).not.toThrow();
    // numeric(3,5) holds 3 significant digits at scale 5 (|value| < 0.01).
    expect(() =>
      buildListQuery(t, { filters: [{ column: 'tiny', op: 'eq', value: '0.00123' }] }),
    ).not.toThrow();
    // real within range, including the smallest denormal and a true zero.
    expect(() =>
      buildListQuery(t, { filters: [{ column: 'ratio', op: 'lt', value: '1e38' }] }),
    ).not.toThrow();
    expect(() =>
      buildListQuery(t, { filters: [{ column: 'ratio', op: 'gte', value: '1e-45' }] }),
    ).not.toThrow();
    expect(() =>
      buildListQuery(t, { filters: [{ column: 'ratio', op: 'eq', value: '0e5' }] }),
    ).not.toThrow();
    // numeric without a typmod is arbitrary precision — a huge value is fine.
    expect(() =>
      buildListQuery(t, {
        filters: [{ column: 'unbounded', op: 'eq', value: '123456789012345678901234567890.5' }],
      }),
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
    expect(q.dataValues).toEqual(['10', '20', DEFAULT_PAGE_SIZE + 1, 0]);
  });

  it('searches across text/textarea columns only, reusing one placeholder', () => {
    const q = buildListQuery(authors, { search: 'lov' });
    expect(q.dataText).toContain('("display_name" ILIKE $1 OR "bio" ILIKE $1)');
    expect(q.dataValues).toEqual(['%lov%', DEFAULT_PAGE_SIZE + 1, 0]);
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
    expect(q.dataValues).toEqual(['1', '%lov%', DEFAULT_PAGE_SIZE + 1, 0]);
  });

  it('honours explicit multi-column sort and appends the PK as a tiebreaker', () => {
    const q = buildListQuery(authors, {
      sort: [
        { field: 'display_name', order: 'desc' },
        { field: 'rank', order: 'asc' },
      ],
    });
    // The PK is appended so the order is total and paging stays stable across
    // rows that tie on the requested (non-unique) columns.
    expect(q.dataText).toContain('ORDER BY "display_name" DESC, "rank" ASC, "id" ASC');
  });

  it('does not duplicate a PK column already named in the explicit sort', () => {
    const q = buildListQuery(authors, { sort: [{ field: 'id', order: 'desc' }] });
    expect(q.dataText).toContain('ORDER BY "id" DESC');
    expect(q.dataText).not.toContain('"id" DESC, "id" ASC');
  });

  it('omits ORDER BY for a view with no primary key and no sort', () => {
    const v = viewResource('vw', [col('a', 'text')]);
    const q = buildListQuery(v, {});
    expect(q.dataText).not.toContain('ORDER BY');
  });

  it('honours an explicit sort on a PK-less view without inventing a tiebreaker', () => {
    const v = viewResource('vw', [col('a', 'text')]);
    const q = buildListQuery(v, { sort: [{ field: 'a', order: 'asc' }] });
    expect(q.dataText).toContain('ORDER BY "a" ASC');
    // No PK to append, so the ORDER BY ends at the requested column.
    expect(q.dataText).toMatch(/ORDER BY "a" ASC(?! *,)/);
  });

  it('appends only the unnamed columns of a composite PK as tiebreakers', () => {
    const lines = tableResource(
      'order_lines',
      [
        col('order_id', 'uuid', { isPrimaryKey: true, nullable: false }),
        col('line_no', 'number', { dataType: 'integer', isPrimaryKey: true, nullable: false }),
        col('note', 'text'),
      ],
      ['order_id', 'line_no'],
    );
    // The sort names one of the two PK columns (DESC); only the other PK column
    // is appended (ASC), and the named one is not re-appended.
    const q = buildListQuery(lines, { sort: [{ field: 'order_id', order: 'desc' }] });
    expect(q.dataText).toContain('ORDER BY "order_id" DESC, "line_no" ASC');
    expect(q.dataText).not.toContain('"order_id" DESC, "line_no" ASC, "order_id"');
  });

  it('clamps pagination (page floor, pageSize cap, defaults)', () => {
    expect(buildListQuery(authors, { page: 0 }).page).toBe(1);
    expect(buildListQuery(authors, { pageSize: 0 }).pageSize).toBe(DEFAULT_PAGE_SIZE);
    expect(buildListQuery(authors, { pageSize: 9999 }).pageSize).toBe(MAX_PAGE_SIZE);
    const q = buildListQuery(authors, { page: 3, pageSize: 10 });
    expect(q.dataValues).toEqual([11, 20]); // LIMIT pageSize+1; offset = (3-1)*10
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
    const q = buildGetQuery(authors, SAMPLE_UUID);
    expect(q.text).toBe(
      'SELECT "id", "display_name", "bio", "rank" FROM "public"."authors" WHERE "id" = $1 LIMIT 1',
    );
    expect(q.values).toEqual([SAMPLE_UUID]);
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
    // A text key (not a pre-flighted family) so the comma value is not also
    // rejected by the #110 id pre-flight — the point here is the no-split rule.
    const textKeyed = tableResource('tk', [
      col('id', 'text', { isPrimaryKey: true, nullable: false }),
      col('name', 'text'),
    ]);
    const q = buildGetQuery(textKeyed, 'a,b');
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
    const q = buildUpdateQuery(authors, SAMPLE_UUID, { display_name: 'Ada2', rank: 2 });
    expect(q.text).toBe(
      'UPDATE "public"."authors" SET "display_name" = $1, "rank" = $2 WHERE "id" = $3 RETURNING "id", "display_name", "bio", "rank"',
    );
    expect(q.values).toEqual(['Ada2', 2, SAMPLE_UUID]);
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
    const q = buildDeleteQuery(authors, SAMPLE_UUID);
    expect(q.text).toBe(
      'DELETE FROM "public"."authors" WHERE "id" = $1 RETURNING "id", "display_name", "bio", "rank"',
    );
    expect(q.values).toEqual([SAMPLE_UUID]);
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

describe('item id pre-flight (#110)', () => {
  const intKeyed = tableResource('counters', [
    col('id', 'number', { dataType: 'integer', isPrimaryKey: true, nullable: false }),
    col('label', 'text'),
  ]);
  const textKeyed = tableResource('slugs', [
    col('id', 'text', { isPrimaryKey: true, nullable: false }),
    col('label', 'text'),
  ]);
  const composite = tableResource(
    'order_lines',
    [
      col('order_id', 'uuid', { isPrimaryKey: true, nullable: false }),
      col('line_no', 'number', { dataType: 'integer', isPrimaryKey: true, nullable: false }),
      col('note', 'text'),
    ],
    ['order_id', 'line_no'],
  );

  it('rejects a non-uuid id against a uuid key (400) on get / update / delete', () => {
    const runs = [
      () => buildGetQuery(authors, 'not-a-uuid'),
      () => buildUpdateQuery(authors, 'not-a-uuid', { display_name: 'x' }),
      () => buildDeleteQuery(authors, 'not-a-uuid'),
    ];
    for (const run of runs) {
      try {
        run();
        expect.unreachable('expected a 400');
      } catch (err) {
        expect(err).toBeInstanceOf(KozouApiError);
        expect((err as KozouApiError).status).toBe(400);
        expect((err as KozouApiError).message).toMatch(
          /Item id component "not-a-uuid" is not valid for primary-key column "id" \(uuid\)/,
        );
      }
    }
  });

  it('rejects a non-integer id against an integer key (400)', () => {
    expect(() => buildGetQuery(intKeyed, 'abc')).toThrow(
      /not valid for primary-key column "id" \(integer\)/,
    );
    expect(() => buildGetQuery(intKeyed, '1.5')).toThrow(/primary-key column "id"/);
    // Parses as an integer but overflows int4.
    expect(() => buildGetQuery(intKeyed, '9999999999')).toThrow(/primary-key column "id"/);
  });

  it('accepts a well-formed uuid / integer id (brace-wrapped uuid included)', () => {
    expect(() => buildGetQuery(authors, SAMPLE_UUID)).not.toThrow();
    expect(() => buildGetQuery(authors, `{${SAMPLE_UUID}}`)).not.toThrow();
    expect(() => buildGetQuery(intKeyed, '42')).not.toThrow();
    expect(() => buildGetQuery(intKeyed, '-7')).not.toThrow();
  });

  it('does not pre-flight a text key — any string (commas included) is a valid id', () => {
    expect(() => buildGetQuery(textKeyed, 'anything,with,commas')).not.toThrow();
  });

  it('validates each component of a composite key by its own type', () => {
    expect(() => buildGetQuery(composite, 'not-a-uuid,1')).toThrow(/"order_id" \(uuid\)/);
    expect(() => buildGetQuery(composite, `${SAMPLE_UUID},abc`)).toThrow(/"line_no" \(integer\)/);
    expect(() => buildGetQuery(composite, `${SAMPLE_UUID},5`)).not.toThrow();
  });

  it('checks composite arity before component type (a wrong count is still the arity 400)', () => {
    expect(() => buildGetQuery(composite, 'only-one')).toThrow(
      /composite primary key.*expected 2/,
    );
  });
});

describe('write-body value pre-flight (#110)', () => {
  const t = tableResource('widgets', [
    col('id', 'uuid', { isPrimaryKey: true, nullable: false }),
    col('ref', 'uuid'),
    col('count', 'number', { dataType: 'integer' }),
    col('amount', 'currency', { dataType: 'numeric(12,2)' }),
    col('approx', 'number', { dataType: 'double precision' }),
    col('active', 'boolean', { dataType: 'boolean' }),
    col('note', 'text', { dataType: 'text' }),
    col('payload', 'text', { dataType: 'jsonb' }),
  ]);

  it('rejects a malformed string scalar for the column type (400), on insert and update', () => {
    expect(() => buildInsertQuery(t, { ref: 'zzz' })).toThrow(
      /Value "zzz" is not valid for column "ref" \(uuid\)/,
    );
    expect(() => buildInsertQuery(t, { count: 'abc' })).toThrow(/column "count" \(integer\)/);
    expect(() => buildInsertQuery(t, { count: '1.5' })).toThrow(/column "count"/);
    expect(() => buildInsertQuery(t, { amount: 'not-money' })).toThrow(/column "amount"/);
    expect(() => buildInsertQuery(t, { active: 'maybe' })).toThrow(/column "active" \(boolean\)/);
    expect(() => buildUpdateQuery(t, SAMPLE_UUID, { ref: 'zzz' })).toThrow(/column "ref" \(uuid\)/);
  });

  it('accepts well-formed string scalars', () => {
    expect(() =>
      buildInsertQuery(t, { ref: SAMPLE_UUID, count: '3', amount: '9.99', active: 'true' }),
    ).not.toThrow();
  });

  it('accepts NaN for any decimal type and ±Infinity for the float types', () => {
    // NaN is valid for every decimal/float type, including numeric(p,s).
    expect(() => buildInsertQuery(t, { amount: 'NaN' })).not.toThrow();
    expect(() => buildInsertQuery(t, { approx: 'NaN' })).not.toThrow();
    // ±Infinity is valid for the float types.
    for (const special of ['Infinity', '-Infinity', 'inf']) {
      expect(() => buildInsertQuery(t, { approx: special })).not.toThrow();
    }
  });

  it('rejects ±Infinity for a constrained numeric(p,s) (400, not a 22003 500)', () => {
    // A numeric(12,2) cannot hold an infinite value (PostgreSQL 22003), so it is
    // caught up front rather than surfacing as a server error.
    expect(() => buildInsertQuery(t, { amount: 'Infinity' })).toThrow(/column "amount"/);
    expect(() => buildInsertQuery(t, { amount: '-Infinity' })).toThrow(/column "amount"/);
    // NaN, by contrast, is valid even for numeric(p,s).
    expect(() => buildInsertQuery(t, { amount: 'NaN' })).not.toThrow();
  });

  it('does not reject an empty string for a text column (empty text is valid)', () => {
    expect(() => buildInsertQuery(t, { note: '' })).not.toThrow();
  });

  it('rejects an empty string for a checked family (empty is invalid for an integer)', () => {
    expect(() => buildInsertQuery(t, { count: '' })).toThrow(/column "count"/);
  });

  it('leaves non-string JSON values to PostgreSQL (number / boolean / null / object)', () => {
    expect(() =>
      buildInsertQuery(t, { count: 5, active: true, ref: null, payload: { a: 1 } }),
    ).not.toThrow();
    // Even a JS number against a uuid column is left to PostgreSQL — only
    // string-valued fields are pre-flighted.
    expect(() => buildInsertQuery(t, { ref: 12345 })).not.toThrow();
  });

  it('does not pre-flight a json or text column carrying a string', () => {
    expect(() => buildInsertQuery(t, { payload: 'not-json', note: 'anything' })).not.toThrow();
  });
});

describe('domain-backed column pre-flight (#85)', () => {
  // A DOMAIN column's dataType is the opaque domain name; introspection resolves
  // one level to the base type + typmod and carries it on `effectiveType`, which
  // the pre-flight consults so an invalid value is a 400 up front, not a 500.
  const t = tableResource('orders', [
    col('id', 'number', {
      dataType: 'posint',
      effectiveType: 'integer',
      isPrimaryKey: true,
      nullable: false,
    }),
    col('price', 'currency', { dataType: 'price', effectiveType: 'numeric(12,2)' }),
    col('ref', 'uuid', { dataType: 'ref_id', effectiveType: 'uuid' }),
    col('label', 'text', { dataType: 'short_text', effectiveType: 'text' }),
  ]);

  it('pre-flights a filter against the domain base type (400, not a 500)', () => {
    expect(() =>
      buildListQuery(t, { filters: [{ column: 'price', op: 'eq', value: 'abc' }] }),
    ).toThrow(/is not valid for column "price"/);
    // Out-of-precision overflow is caught against the resolved numeric(12,2).
    expect(() =>
      buildListQuery(t, { filters: [{ column: 'price', op: 'eq', value: '1e40' }] }),
    ).toThrow(/is not valid for column "price"/);
    expect(() =>
      buildListQuery(t, { filters: [{ column: 'ref', op: 'eq', value: 'not-a-uuid' }] }),
    ).toThrow(/is not valid for column "ref"/);
    // A value valid for the base type still passes.
    expect(() =>
      buildListQuery(t, { filters: [{ column: 'price', op: 'eq', value: '12.34' }] }),
    ).not.toThrow();
  });

  it('pre-flights an item id and write-body value against the domain base type', () => {
    expect(() => buildGetQuery(t, 'abc')).toThrow(
      /Item id component "abc" is not valid for primary-key column "id" \(posint\)/,
    );
    expect(() => buildGetQuery(t, '42')).not.toThrow();
    expect(() => buildInsertQuery(t, { ref: 'zzz' })).toThrow(
      /Value "zzz" is not valid for column "ref" \(ref_id\)/,
    );
    expect(() => buildInsertQuery(t, { price: 'not-money' })).toThrow(/column "price" \(price\)/);
    expect(() => buildInsertQuery(t, { ref: SAMPLE_UUID, price: '9.99' })).not.toThrow();
  });

  it('resolves operator compatibility against the base type (like on a domain-over-text)', () => {
    // like/ilike require a text-like base; a domain over text qualifies, a domain
    // over numeric does not.
    expect(() =>
      buildListQuery(t, { filters: [{ column: 'label', op: 'ilike', value: 'foo' }] }),
    ).not.toThrow();
    expect(() =>
      buildListQuery(t, { filters: [{ column: 'price', op: 'like', value: 'foo' }] }),
    ).toThrow(/requires a text-like column/);
  });

  it('without a resolved effectiveType, a domain name falls through unchecked (back-compat)', () => {
    // A ColumnContext built before #85 (no effectiveType) keeps the pre-#85
    // behavior: the opaque domain name is not a checkable family, so the value is
    // left to PostgreSQL. `effectiveType ?? dataType` is the fallback.
    const legacy = tableResource('legacy', [
      col('id', 'uuid', { isPrimaryKey: true, nullable: false }),
      col('price', 'currency', { dataType: 'price' }), // no effectiveType
    ]);
    expect(() =>
      buildListQuery(legacy, { filters: [{ column: 'price', op: 'eq', value: 'abc' }] }),
    ).not.toThrow();
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

  it('selects every primary-key column for a composite-key resource', () => {
    const lines = tableResource(
      'order_lines',
      [
        col('order_id', 'uuid', { isPrimaryKey: true, nullable: false }),
        col('line_no', 'number', { dataType: 'integer', isPrimaryKey: true, nullable: false }),
        col('note', 'text'),
      ],
      ['order_id', 'line_no'],
    );
    const q = buildRelationOptionsQuery(lines, {
      labelField: 'note',
      searchFields: ['note'],
      query: 'x',
    });
    expect(q.text).toBe(
      'SELECT "order_id", "line_no", "note" FROM "public"."order_lines" WHERE ("note" ILIKE $1) LIMIT $2',
    );
    expect(q.primaryKeys).toEqual(['order_id', 'line_no']);
    expect(q.primaryKey).toBe('order_id');
  });

  it('does not select the label twice when it is a composite-key component', () => {
    const lines = tableResource(
      'order_lines',
      [
        col('order_id', 'uuid', { isPrimaryKey: true, nullable: false }),
        col('line_no', 'number', { dataType: 'integer', isPrimaryKey: true, nullable: false }),
      ],
      ['order_id', 'line_no'],
    );
    const q = buildRelationOptionsQuery(lines, { labelField: 'line_no', searchFields: [] });
    expect(q.text).toBe('SELECT "order_id", "line_no" FROM "public"."order_lines" LIMIT $1');
  });

  it('rejects a key-less resource with 400', () => {
    const view = viewResource('vw_active', [col('id', 'uuid'), col('label', 'text')]);
    try {
      buildRelationOptionsQuery(view, { labelField: 'label', searchFields: [] });
      expect.unreachable('expected a 400');
    } catch (err) {
      expect(err).toBeInstanceOf(KozouApiError);
      expect((err as KozouApiError).status).toBe(400);
      expect((err as KozouApiError).message).toMatch(/has no primary key/);
    }
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
      filters: [{ column: 'author_id', op: 'eq', value: SAMPLE_UUID }],
      search: 'foo',
      embed: embedAuthors,
    });
    expect(q.dataText).toContain('WHERE "author_id" = $1 AND ("title" ILIKE $2)');
    expect(q.dataText).toContain('LIMIT $3 OFFSET $4');
    expect(q.dataValues).toEqual([SAMPLE_UUID, '%foo%', DEFAULT_PAGE_SIZE + 1, 0]);
  });

  it('leaves the count query untouched when embedding', () => {
    const q = buildListQuery(books, { embed: embedAuthors });
    expect(q.countText).toBe('SELECT count(*) AS total FROM "public"."books"');
    expect(q.countValues).toEqual([]);
  });

  it('splices an embed fragment into the by-id query and keeps $1', () => {
    const q = buildGetQuery(books, SAMPLE_UUID, embedAuthors);
    expect(q.text).toContain('AS "authors"');
    expect(q.text).toContain('WHERE "id" = $1 LIMIT 1');
    expect(q.values).toEqual([SAMPLE_UUID]);
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
