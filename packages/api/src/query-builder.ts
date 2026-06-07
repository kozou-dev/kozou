// Pure SQL builders for the read path. No I/O — given a resolved Resource
// and structured request params, produce parameterized SQL text + values.
//
// Safety contract:
//   - Identifiers (table/column names) only ever come from the resolved
//     Resource's own schema/name/columns, never raw request strings. Any
//     filter/sort key that is not a declared column is rejected with a
//     400 before it reaches the SQL text.
//   - Every user-supplied value is a bound parameter ($1, $2, ...). No
//     value is interpolated into the SQL string.

import type { ColumnContext } from '@kozou/core';

import { badRequest } from './errors.js';
import { quoteIdent, qualified } from './ident.js';
import { buildEmbedSelectFragment, type EmbedNode } from './embed.js';
import type { Resource } from './schema-lookup.js';

export { quoteIdent };

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

export type SortDirection = 'asc' | 'desc';

/** Horizontal filter operators for the `?<col>=<op>.<value>` query grammar. */
export type FilterOperator =
  | 'eq'
  | 'neq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'like'
  | 'ilike'
  | 'in'
  | 'is';

/** Comparison operators that bind a single value. */
export type ScalarFilterOperator = Exclude<FilterOperator, 'in' | 'is'>;

/** Allowed right-hand keywords for the `is` operator (never bound — a fixed
 *  SQL `IS [NOT] NULL/TRUE/FALSE` clause). */
export type IsKeyword = 'null' | 'notnull' | 'true' | 'false';

/** A single horizontal filter. `column` must be a declared column of the
 *  resource (enforced in {@link buildListQuery}). Multiple filters on the same
 *  column are allowed and combine with AND (e.g. a `gte`/`lte` range). */
export type Filter =
  | { column: string; op: ScalarFilterOperator; value: string }
  | { column: string; op: 'in'; values: string[] }
  | { column: string; op: 'is'; keyword: IsKeyword };

export type ListQueryParams = {
  page?: number;
  pageSize?: number;
  sort?: { field: string; order: SortDirection }[];
  search?: string;
  /** Horizontal filters. Each filter's column must be a declared column of
   *  the resource; every supplied value is a bound parameter. */
  filters?: Filter[];
  /** Resolved forward to-one relations to inline as nested JSON objects. */
  embed?: EmbedNode[];
};

const SCALAR_OP_SQL: Record<ScalarFilterOperator, string> = {
  eq: '=',
  neq: '<>',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
  like: 'LIKE',
  ilike: 'ILIKE',
};

const IS_KEYWORD_SQL: Record<IsKeyword, string> = {
  null: 'NULL',
  notnull: 'NOT NULL',
  true: 'TRUE',
  false: 'FALSE',
};

/** Wildcard mapping for LIKE/ILIKE: a literal `*` in the pattern maps to SQL
 *  `%`. Plain linear string replacement — no regular expression (avoids ReDoS,
 *  per the CodeQL `js/polynomial-redos` precedent). */
function toLikePattern(value: string): string {
  return value.split('*').join('%');
}

/** Reduce a `format_type`-style `dataType` to its base scalar type name, or
 *  `null` when it is an array (`text[]`) — arrays are not scalar `LIKE` /
 *  boolean targets. Lower-cases, drops a trailing length/precision modifier
 *  (`character varying(255)` -> `character varying`), and trims. No regex
 *  (linear scan), per the CodeQL `js/polynomial-redos` precedent. */
function baseScalarType(dataType: string): string | null {
  const lower = dataType.trim().toLowerCase();
  if (lower.includes('[')) return null; // any array spelling, e.g. text[]
  const paren = lower.indexOf('(');
  return (paren === -1 ? lower : lower.slice(0, paren)).trim();
}

/** Base scalar types that accept `LIKE` / `ILIKE`. Judged by the underlying
 *  PostgreSQL type, not the widget — a `varchar` surfaced as an `enum-select`
 *  still accepts `ilike` (Kozou v1.0 issue #76). Exact-match on the normalized
 *  base type so array spellings (`text[]`) are excluded. */
const TEXT_LIKE_BASE_TYPES = new Set([
  'text',
  'character varying',
  'varchar',
  'character',
  'char',
  'bpchar',
  'citext',
  'name',
]);

function isTextLikeType(dataType: string): boolean {
  const base = baseScalarType(dataType);
  return base !== null && TEXT_LIKE_BASE_TYPES.has(base);
}

/** A boolean column — the only type for which `is.true` / `is.false` is valid
 *  (a `boolean[]` array is excluded). */
function isBooleanType(dataType: string): boolean {
  const base = baseScalarType(dataType);
  return base === 'boolean' || base === 'bool';
}

/** Inclusive [min, max] range for each integer width, used to reject values
 *  that parse as integers but overflow the column type at execution. */
const INTEGER_BOUNDS: Record<string, [bigint, bigint]> = {
  smallint: [-32768n, 32767n],
  int2: [-32768n, 32767n],
  integer: [-2147483648n, 2147483647n],
  int: [-2147483648n, 2147483647n],
  int4: [-2147483648n, 2147483647n],
  bigint: [-9223372036854775808n, 9223372036854775807n],
  int8: [-9223372036854775808n, 9223372036854775807n],
};
const DECIMAL_BASE_TYPES = new Set([
  'numeric',
  'decimal',
  'real',
  'double precision',
  'float',
  'float4',
  'float8',
]);
const BOOLEAN_LITERALS = new Set([
  'true',
  'false',
  't',
  'f',
  'yes',
  'no',
  'y',
  'n',
  'on',
  'off',
  '1',
  '0',
]);

/** A plain base-10 integer literal (optional sign, then digits). A manual
 *  scan — no regex — so it rejects the `0x`/`0b`/`0o` and exponent forms that
 *  JavaScript's `Number` tolerates but a PostgreSQL integer column does not. */
function isPlainInteger(s: string): boolean {
  let i = 0;
  if (s[0] === '+' || s[0] === '-') i = 1;
  if (i === s.length) return false; // sign only / empty
  for (; i < s.length; i++) {
    if (s[i] < '0' || s[i] > '9') return false;
  }
  return true;
}

/** A lexical decimal literal: optional sign, an integer and/or fractional
 *  part (at least one digit overall), and an optional exponent. A manual scan
 *  (no regex) that validates *syntax only* — it does not coerce through JS
 *  `Number`, so arbitrary-precision PostgreSQL `numeric` values (hundreds of
 *  digits, magnitudes beyond JS range) are accepted, while `abc`, `0x10`, and
 *  `NaN`/`Infinity` are rejected. Range/precision are left to PostgreSQL. */
function isLexicalDecimal(s: string): boolean {
  let i = 0;
  const n = s.length;
  if (i < n && (s[i] === '+' || s[i] === '-')) i++;
  let digits = 0;
  while (i < n && s[i] >= '0' && s[i] <= '9') {
    i++;
    digits++;
  }
  if (i < n && s[i] === '.') {
    i++;
    while (i < n && s[i] >= '0' && s[i] <= '9') {
      i++;
      digits++;
    }
  }
  if (digits === 0) return false; // need at least one digit somewhere
  if (i < n && (s[i] === 'e' || s[i] === 'E')) {
    i++;
    if (i < n && (s[i] === '+' || s[i] === '-')) i++;
    let expDigits = 0;
    while (i < n && s[i] >= '0' && s[i] <= '9') {
      i++;
      expDigits++;
    }
    if (expDigits === 0) return false;
  }
  return i === n; // the whole string was consumed
}

/** Whether a string filter value parses as the column's base scalar type, for
 *  the types where a bad value would otherwise surface only at execution as a
 *  500: integer family (exact, with width range), decimal/float family
 *  (lexical syntax), and boolean. Other types (uuid / date / json / ...) are
 *  not pre-checked and fall through to PostgreSQL.
 *
 *  Documented residual (follow-up #81): only *syntax* is validated for the
 *  decimal/float family — true range overflow (`real`/`double precision`) and
 *  `numeric(p,s)` precision overflow still reach PostgreSQL. Validating syntax
 *  (not range) avoids false-rejecting valid arbitrary-precision `numeric`
 *  values, which JS `Number` range cannot represent. */
function valueFitsType(base: string, value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === '') return false;
  const bounds = INTEGER_BOUNDS[base];
  if (bounds !== undefined) {
    if (!isPlainInteger(trimmed)) return false;
    const n = BigInt(trimmed);
    return n >= bounds[0] && n <= bounds[1];
  }
  if (DECIMAL_BASE_TYPES.has(base)) {
    return isLexicalDecimal(trimmed);
  }
  if (base === 'boolean' || base === 'bool') {
    return BOOLEAN_LITERALS.has(trimmed.toLowerCase());
  }
  return true;
}

/**
 * Reject a filter value that cannot parse as the column's type *before* the
 * query runs (Kozou v1.0 issue #76). Limited to numeric-family and boolean
 * columns — the common cases that otherwise raise a PostgreSQL data error
 * (a 500) at execution. The check is tied to the bound filter value, so a
 * 400 here is unambiguously client-caused (no server/view error is masked).
 */
function assertFilterValueParsable(
  filter: Filter,
  column: ColumnContext,
  resource: Resource,
): void {
  if (filter.op === 'is') return; // fixed keyword clause, no bound value
  const base = baseScalarType(column.dataType);
  if (base === null) return; // array etc. — not value-checked here
  const values = filter.op === 'in' ? filter.values : [filter.value];
  for (const value of values) {
    if (!valueFitsType(base, value)) {
      throw badRequest(
        `Filter value "${value}" is not valid for column "${filter.column}" (${column.dataType}) ` +
          `on resource "${resource.name}".`,
      );
    }
  }
}

/**
 * Reject statically-knowable operator/column-type mismatches with a 400 before
 * the query runs (Kozou v1.0 issue #76): `like`/`ilike` need a text-like
 * column, and `is.true`/`is.false` need a boolean column. Value-format
 * mismatches that only surface at execution (e.g. `eq.abc` on a numeric
 * column) are mapped to 400 by the handler's error classifier instead.
 */
function assertFilterTypeCompatible(
  filter: Filter,
  column: ColumnContext,
  resource: Resource,
): void {
  if ((filter.op === 'like' || filter.op === 'ilike') && !isTextLikeType(column.dataType)) {
    throw badRequest(
      `Operator "${filter.op}" requires a text-like column; "${filter.column}" on resource ` +
        `"${resource.name}" is ${column.dataType}.`,
    );
  }
  if (
    filter.op === 'is' &&
    (filter.keyword === 'true' || filter.keyword === 'false') &&
    !isBooleanType(column.dataType)
  ) {
    throw badRequest(
      `Filter "is.${filter.keyword}" requires a boolean column; "${filter.column}" on resource ` +
        `"${resource.name}" is ${column.dataType}.`,
    );
  }
}

export type BuiltListQuery = {
  dataText: string;
  dataValues: unknown[];
  countText: string;
  countValues: unknown[];
  /** Effective (clamped) pagination echoed back in the response. */
  page: number;
  pageSize: number;
};

export type BuiltGetQuery = {
  text: string;
  values: unknown[];
};

function selectColumns(resource: Resource): string {
  if (resource.columns.length === 0) return '*';
  return resource.columns.map((c) => quoteIdent(c.name)).join(', ');
}

/** Columns that free-text search targets: text-like widgets whose underlying
 *  type is also text-like. uuid / enum / numeric columns are excluded (an
 *  `ILIKE` against them either errors or is meaningless), as are text-widget
 *  columns whose real type is an array / domain / other non-text scalar — the
 *  base-type guard keeps `?search=` from emitting an ILIKE that PostgreSQL
 *  rejects (Kozou v1.0 issue #76). */
function searchableColumns(resource: Resource): string[] {
  return resource.columns
    .filter(
      (c) => (c.widget === 'text' || c.widget === 'textarea') && isTextLikeType(c.dataType),
    )
    .map((c) => c.name);
}

function clampPageSize(pageSize: number | undefined): number {
  if (pageSize === undefined || !Number.isFinite(pageSize) || pageSize < 1) {
    return DEFAULT_PAGE_SIZE;
  }
  return Math.min(Math.floor(pageSize), MAX_PAGE_SIZE);
}

function clampPage(page: number | undefined): number {
  if (page === undefined || !Number.isFinite(page) || page < 1) return 1;
  return Math.floor(page);
}

export function buildListQuery(
  resource: Resource,
  params: ListQueryParams,
): BuiltListQuery {
  const columnsByName = new Map(resource.columns.map((c) => [c.name, c]));

  const whereParts: string[] = [];
  const whereValues: unknown[] = [];
  const nextParam = (): string => `$${whereValues.length + 1}`;

  // Horizontal filters. The column allowlist is the resource's own columns;
  // every supplied value is a bound parameter ($n). `is` emits a fixed
  // keyword clause (no value bound).
  for (const filter of params.filters ?? []) {
    const columnDef = columnsByName.get(filter.column);
    if (columnDef === undefined) {
      throw badRequest(`Unknown filter column "${filter.column}" on resource "${resource.name}".`);
    }
    assertFilterTypeCompatible(filter, columnDef, resource);
    assertFilterValueParsable(filter, columnDef, resource);
    const column = quoteIdent(filter.column);
    if (filter.op === 'in') {
      if (filter.values.length === 0) {
        throw badRequest(`Filter "${filter.column}=in.()" needs at least one value.`);
      }
      const placeholders: string[] = [];
      for (const value of filter.values) {
        placeholders.push(nextParam());
        whereValues.push(value);
      }
      whereParts.push(`${column} IN (${placeholders.join(', ')})`);
    } else if (filter.op === 'is') {
      whereParts.push(`${column} IS ${IS_KEYWORD_SQL[filter.keyword]}`);
    } else {
      whereParts.push(`${column} ${SCALAR_OP_SQL[filter.op]} ${nextParam()}`);
      whereValues.push(
        filter.op === 'like' || filter.op === 'ilike'
          ? toLikePattern(filter.value)
          : filter.value,
      );
    }
  }

  // Free-text search across text-like columns.
  const search = params.search?.trim();
  if (search !== undefined && search.length > 0) {
    const cols = searchableColumns(resource);
    if (cols.length > 0) {
      const placeholder = nextParam();
      whereValues.push(`%${search}%`);
      const ors = cols.map((c) => `${quoteIdent(c)} ILIKE ${placeholder}`).join(' OR ');
      whereParts.push(`(${ors})`);
    }
  }

  const whereClause = whereParts.length > 0 ? ` WHERE ${whereParts.join(' AND ')}` : '';

  // ORDER BY: explicit sort, else default to the primary key for stable
  // pagination. Views (no PK) fall back to no ordering.
  const orderParts: string[] = [];
  if (params.sort && params.sort.length > 0) {
    for (const s of params.sort) {
      if (!columnsByName.has(s.field)) {
        throw badRequest(`Unknown sort column "${s.field}" on resource "${resource.name}".`);
      }
      orderParts.push(`${quoteIdent(s.field)} ${s.order === 'desc' ? 'DESC' : 'ASC'}`);
    }
  } else {
    for (const pk of resource.primaryKey) {
      orderParts.push(`${quoteIdent(pk)} ASC`);
    }
  }
  const orderClause = orderParts.length > 0 ? ` ORDER BY ${orderParts.join(', ')}` : '';

  const page = clampPage(params.page);
  const pageSize = clampPageSize(params.pageSize);
  const offset = (page - 1) * pageSize;

  const cols = selectColumns(resource);
  const table = qualified(resource);
  // Embeds append correlated subqueries to the SELECT list only — they add no
  // bound parameters, so the $n numbering above is unaffected.
  const embedSql =
    params.embed && params.embed.length > 0
      ? buildEmbedSelectFragment(params.embed, table, { n: 0 })
      : '';

  const dataValues = [...whereValues, pageSize, offset];
  const limitParam = `$${whereValues.length + 1}`;
  const offsetParam = `$${whereValues.length + 2}`;
  const dataText = `SELECT ${cols}${embedSql} FROM ${table}${whereClause}${orderClause} LIMIT ${limitParam} OFFSET ${offsetParam}`;

  const countText = `SELECT count(*) AS total FROM ${table}${whereClause}`;

  return {
    dataText,
    dataValues,
    countText,
    countValues: [...whereValues],
    page,
    pageSize,
  };
}

/** Primary key columns for an item-by-id operation. A PK-less resource (a
 *  view, or a table without a primary key) cannot be addressed by id. */
function primaryKey(resource: Resource): string[] {
  if (resource.primaryKey.length === 0) {
    throw badRequest(
      `Resource "${resource.name}" has no primary key; fetch/update/delete by id is unavailable.`,
    );
  }
  return resource.primaryKey;
}

/**
 * Resolve the bound key values from an item id segment.
 *
 * A single-column PK takes the id verbatim, so the value may itself contain a
 * comma. A composite PK splits the segment on commas into one component per
 * key column, in `primaryKey` declaration order; the component count must
 * match the key arity (else 400).
 *
 * Limitation: with a composite key, a key *value* cannot contain a comma (the
 * segment is split after URL-decoding). Single-column keys are unaffected.
 */
function resolveKeyValues(resource: Resource, id: string, keyColumns: string[]): string[] {
  if (keyColumns.length === 1) return [id];
  const parts = id.split(',');
  if (parts.length !== keyColumns.length) {
    throw badRequest(
      `Resource "${resource.name}" has a composite primary key (${keyColumns.join(', ')}); ` +
        `expected ${keyColumns.length} comma-separated key components, got ${parts.length}.`,
    );
  }
  return parts;
}

/** `pk0 = $start AND pk1 = $start+1 AND ...` for the given key columns. */
function keyWhereClause(keyColumns: string[], startParam: number): string {
  return keyColumns.map((c, i) => `${quoteIdent(c)} = $${startParam + i}`).join(' AND ');
}

export function buildGetQuery(
  resource: Resource,
  id: string,
  embed?: EmbedNode[],
): BuiltGetQuery {
  const keyColumns = primaryKey(resource);
  const keyValues = resolveKeyValues(resource, id, keyColumns);
  const table = qualified(resource);
  const embedSql =
    embed && embed.length > 0 ? buildEmbedSelectFragment(embed, table, { n: 0 }) : '';
  const where = keyWhereClause(keyColumns, 1);
  const text = `SELECT ${selectColumns(resource)}${embedSql} FROM ${table} WHERE ${where} LIMIT 1`;
  return { text, values: keyValues };
}

// --- Write path (Phase 2) --------------------------------------------------

export type BuiltMutation = {
  text: string;
  values: unknown[];
};

export const DEFAULT_RELATION_LIMIT = 20;
export const MAX_RELATION_LIMIT = 100;

export type RelationOptionsParams = {
  labelField: string;
  searchFields: string[];
  query?: string;
  limit?: number;
};

export type BuiltRelationOptions = {
  text: string;
  values: unknown[];
  primaryKey: string;
  labelField: string;
};

function singlePrimaryKey(resource: Resource): string {
  if (resource.primaryKey.length !== 1) {
    throw badRequest(
      `Resource "${resource.name}" does not have a single-column primary key.`,
    );
  }
  return resource.primaryKey[0];
}

function assertKnownColumns(resource: Resource, keys: string[]): void {
  const columnNames = new Set(resource.columns.map((c) => c.name));
  for (const key of keys) {
    if (!columnNames.has(key)) {
      throw badRequest(`Unknown column "${key}" on resource "${resource.name}".`);
    }
  }
}

export function buildInsertQuery(
  resource: Resource,
  data: Record<string, unknown>,
): BuiltMutation {
  const keys = Object.keys(data);
  assertKnownColumns(resource, keys);

  const returning = selectColumns(resource);
  const table = qualified(resource);

  // No columns supplied: insert a row of all column defaults.
  if (keys.length === 0) {
    return { text: `INSERT INTO ${table} DEFAULT VALUES RETURNING ${returning}`, values: [] };
  }

  const cols = keys.map(quoteIdent).join(', ');
  const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
  const values = keys.map((k) => data[k]);
  return {
    text: `INSERT INTO ${table} (${cols}) VALUES (${placeholders}) RETURNING ${returning}`,
    values,
  };
}

export function buildUpdateQuery(
  resource: Resource,
  id: string,
  data: Record<string, unknown>,
): BuiltMutation {
  const keyColumns = primaryKey(resource);
  const keys = Object.keys(data);
  if (keys.length === 0) {
    throw badRequest(`No fields to update on resource "${resource.name}".`);
  }
  assertKnownColumns(resource, keys);
  const keyValues = resolveKeyValues(resource, id, keyColumns);

  const sets = keys.map((k, i) => `${quoteIdent(k)} = $${i + 1}`).join(', ');
  const values = [...keys.map((k) => data[k]), ...keyValues];
  const where = keyWhereClause(keyColumns, keys.length + 1);
  const text = `UPDATE ${qualified(resource)} SET ${sets} WHERE ${where} RETURNING ${selectColumns(resource)}`;
  return { text, values };
}

export function buildDeleteQuery(resource: Resource, id: string): BuiltMutation {
  const keyColumns = primaryKey(resource);
  const keyValues = resolveKeyValues(resource, id, keyColumns);
  const where = keyWhereClause(keyColumns, 1);
  const text = `DELETE FROM ${qualified(resource)} WHERE ${where} RETURNING ${selectColumns(resource)}`;
  return { text, values: keyValues };
}

function clampRelationLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit < 1) return DEFAULT_RELATION_LIMIT;
  return Math.min(Math.floor(limit), MAX_RELATION_LIMIT);
}

/** Lightweight `{ id, label }` lookup used by relation-select widgets. */
export function buildRelationOptionsQuery(
  resource: Resource,
  params: RelationOptionsParams,
): BuiltRelationOptions {
  const pk = singlePrimaryKey(resource);
  assertKnownColumns(resource, [params.labelField, ...params.searchFields]);

  // `searchFields` is request-controlled (`?as=options&fields=`); each is
  // ILIKE'd below, so reject a non-text-like field with a 400 rather than
  // letting PostgreSQL raise an operator error (a 500) at execution
  // (Kozou v1.0 issue #76).
  const columnsByName = new Map(resource.columns.map((c) => [c.name, c]));
  for (const field of params.searchFields) {
    const column = columnsByName.get(field);
    if (column !== undefined && !isTextLikeType(column.dataType)) {
      throw badRequest(
        `Relation search field "${field}" must be a text-like column; it is ${column.dataType}.`,
      );
    }
  }

  const values: unknown[] = [];
  let where = '';
  const q = params.query?.trim();
  if (q !== undefined && q.length > 0 && params.searchFields.length > 0) {
    values.push(`%${q}%`);
    const ors = params.searchFields.map((f) => `${quoteIdent(f)} ILIKE $1`).join(' OR ');
    where = ` WHERE (${ors})`;
  }

  values.push(clampRelationLimit(params.limit));
  const limitParam = `$${values.length}`;

  const cols =
    params.labelField === pk
      ? quoteIdent(pk)
      : `${quoteIdent(pk)}, ${quoteIdent(params.labelField)}`;
  const text = `SELECT ${cols} FROM ${qualified(resource)}${where} LIMIT ${limitParam}`;

  return { text, values, primaryKey: pk, labelField: params.labelField };
}
