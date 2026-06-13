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

/** The column type string to use for value pre-flight and operator-compatibility
 *  checks: a DOMAIN column's `dataType` is the opaque domain name (e.g. "price"),
 *  which masks the base type from `baseScalarType` / `valueFitsType` and lets an
 *  invalid value reach PostgreSQL as a 500 (issue #85). `effectiveType` carries
 *  the base type + typmod resolved one level during introspection (e.g.
 *  "numeric(12,2)"); fall back to `dataType` for columns built without it. */
function preflightType(column: ColumnContext): string {
  return column.effectiveType ?? column.dataType;
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

/** Non-finite literals PostgreSQL accepts for the decimal/float family.
 *  `NaN` is valid for every such type (`real`, `double precision`, and — since
 *  PostgreSQL 14 — `numeric`, including a constrained `numeric(p,s)`).
 *  `±Infinity` is valid for the float types and for an *unbounded* `numeric`,
 *  but a constrained `numeric(p,s)` rejects it (22003); `valueFitsType`
 *  enforces that distinction. Matched case-insensitively. Listed here because
 *  they carry no digits, so `isLexicalDecimal` would otherwise reject them;
 *  they are genuine values a column may store, not alternate spellings.
 *  Verified against PostgreSQL 16 `pg_input_is_valid`. */
const SPECIAL_FLOAT_LITERALS = new Set([
  'nan',
  'inf',
  '+inf',
  '-inf',
  'infinity',
  '+infinity',
  '-infinity',
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

/** Whether a string is syntactically valid input for a PostgreSQL `uuid`.
 *  PostgreSQL accepts the 32 hex digits in either case, optionally wrapped in a
 *  single pair of braces, and is lenient about hyphens. This check strips an
 *  optional surrounding `{...}` and every hyphen, then requires exactly 32 hex
 *  digits. It is deliberately *more* permissive than PostgreSQL about hyphen
 *  placement and surrounding whitespace, so that a value PostgreSQL would
 *  accept is never falsely rejected; an over-permissive accept simply falls
 *  through to the same execution error as before (no regression). Verified
 *  against PostgreSQL 16 `pg_input_is_valid(v, 'uuid')`. No regex (linear
 *  scan), per the CodeQL `js/polynomial-redos` precedent. */
function isUuidLexical(s: string): boolean {
  let body = s.trim();
  if (body.length >= 2 && body[0] === '{' && body[body.length - 1] === '}') {
    body = body.slice(1, -1);
  }
  let hex = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '-') continue;
    const isHex =
      (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
    if (!isHex) return false;
    hex++;
  }
  return hex === 32;
}

/** A plain base-10 integer literal (optional sign, then digits). A manual
 *  scan — no regex. This is a deliberately *canonical* form: it rejects the
 *  `0x`/`0o`/`0b` and digit-group-underscore spellings that PostgreSQL 16 does
 *  accept, as well as the exponent forms JavaScript's `Number` tolerates. Those
 *  alternative spellings denote values the client can equally send in plain
 *  decimal, so pre-flight requires the canonical form rather than carrying a
 *  full literal grammar (a value PostgreSQL would accept but this rejects is
 *  only ever a re-spelling, never a value that cannot otherwise be expressed). */
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
 *  `NaN`/`Infinity` are rejected. Range / precision are checked separately
 *  (see `decimalFitsRange`). */
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

/** Parse a `numeric(p,s)` / `numeric(p)` type modifier out of a `format_type`
 *  string, or `null` when the type carries none (arbitrary-precision numeric).
 *  Linear scan / split — no regex (CodeQL `js/polynomial-redos` precedent). */
function numericTypmod(dataType: string): { precision: number; scale: number } | null {
  const open = dataType.indexOf('(');
  if (open === -1) return null;
  const close = dataType.indexOf(')', open + 1);
  if (close === -1) return null;
  const parts = dataType.slice(open + 1, close).split(',');
  const precision = Number.parseInt(parts[0].trim(), 10);
  if (!Number.isInteger(precision)) return null;
  const scale = parts.length > 1 ? Number.parseInt(parts[1].trim(), 10) : 0;
  if (!Number.isInteger(scale)) return null;
  return { precision, scale };
}

/** Number of decimal digits of a non-negative BigInt (`0n` -> 1). */
function bigIntDigits(n: bigint): number {
  return n === 0n ? 1 : n.toString().length;
}

/** Whether a lexically-valid decimal fits `numeric(precision, scale)`.
 *  PostgreSQL rounds the value to `scale` fractional digits, then requires the
 *  result to fit in `precision` total significant digits — i.e. the value
 *  scaled to an integer in units of `10^-scale` must have at most `precision`
 *  digits. Done with BigInt so rounding carry (`9999999999.995` ->
 *  `10000000000.00` on `numeric(12,2)`) is exact and arbitrary-precision values
 *  are never lost. A huge exponent is handled without materialising `10^exp`. */
function numericFitsTypmod(value: string, precision: number, scale: number): boolean {
  let s = value.trim();
  if (s[0] === '+' || s[0] === '-') s = s.slice(1);
  let eIdx = s.indexOf('e');
  if (eIdx === -1) eIdx = s.indexOf('E');
  let exp = 0;
  if (eIdx !== -1) {
    exp = Number.parseInt(s.slice(eIdx + 1), 10);
    s = s.slice(0, eIdx);
  }
  const dot = s.indexOf('.');
  const intPart = dot === -1 ? s : s.slice(0, dot);
  const fracPart = dot === -1 ? '' : s.slice(dot + 1);
  const d = intPart + fracPart === '' ? 0n : BigInt(intPart + fracPart);
  if (d === 0n) return true; // zero fits any numeric(p, s)
  // value = d * 10^(exp - fracPart.length); the rounded scaled integer is
  // R = round(value * 10^scale) = round(d * 10^j), and we need it to have at
  // most `precision` digits.
  const j = exp - fracPart.length + scale;
  if (j >= 0) {
    // d * 10^j has exactly bigIntDigits(d) + j digits — no exponentiation.
    return bigIntDigits(d) + j <= precision;
  }
  const drop = -j;
  // Dropping more digits than d has rounds the magnitude to 0 or 1 — always fits.
  if (drop > bigIntDigits(d)) return true;
  const pow = 10n ** BigInt(drop); // drop <= digit count, so this is bounded
  const q = d / pow;
  const rem = d % pow;
  const r = rem * 2n >= pow ? q + 1n : q; // round half away from zero (PostgreSQL)
  return bigIntDigits(r) <= precision;
}

/** Whether a lexically-valid decimal is genuinely zero — all mantissa digits
 *  are zero (`0`, `0.0`, `0e5`) — rather than a nonzero value that merely
 *  rounds to zero. Scans the mantissa only, not the exponent. */
function isLexicalZero(value: string): boolean {
  let end = value.indexOf('e');
  if (end === -1) end = value.indexOf('E');
  if (end === -1) end = value.length;
  for (let i = 0; i < end; i++) {
    if (value[i] >= '1' && value[i] <= '9') return false;
  }
  return true;
}

/** Whether a lexically-valid decimal is representable by a PostgreSQL float
 *  type. PostgreSQL rejects both overflow (magnitude above the type maximum)
 *  and underflow (a nonzero magnitude that rounds to zero in the type). `real`
 *  is IEEE single precision, so round through `Math.fround` — it maps an
 *  overflow to `Infinity` and an underflow to `0`; `double precision` is IEEE
 *  double, which JS `Number` models exactly. */
function floatFits(value: string, single: boolean): boolean {
  const n = single ? Math.fround(Number(value)) : Number(value);
  if (!Number.isFinite(n)) return false; // overflow -> Infinity
  return n !== 0 || isLexicalZero(value); // nonzero input rounding to 0 = underflow
}

/** Whether a lexically-valid decimal fits the decimal/float column's range.
 *  `numeric(p,s)`: see `numericFitsTypmod` (rounded to `scale`, must fit in `p`
 *  total digits); without a typmod, precision is unlimited. `real` /
 *  `double precision`: must be within the type's representable range. */
function decimalFitsRange(base: string, dataType: string, value: string): boolean {
  if (base === 'real' || base === 'float4') return floatFits(value, true);
  if (base === 'double precision' || base === 'float8' || base === 'float') {
    return floatFits(value, false);
  }
  const typmod = numericTypmod(dataType);
  if (typmod === null) return true; // arbitrary precision — no precision bound
  return numericFitsTypmod(value, typmod.precision, typmod.scale);
}

/** Whether a string value parses as the column's type, for the scalar families
 *  where a bad value would otherwise surface only at execution as a 500:
 *  integer family (exact, with width range), decimal/float family (lexical
 *  syntax plus range/precision (issue #81), plus the non-finite literals
 *  `NaN` / `±Infinity`), boolean, and uuid (issue #110). Other types (date /
 *  json / text / ...) are not pre-checked and fall through to PostgreSQL.
 *
 *  The check is a conservative under-approximation of PostgreSQL's accepted
 *  input: it must never reject a value PostgreSQL would accept *and that
 *  expresses a distinct value*. It deliberately does reject some valid but
 *  redundant spellings (PostgreSQL 16 non-decimal / underscored integer
 *  literals; abbreviated boolean prefixes like `tr` / `fa`) — those re-spell a
 *  value the client can also send canonically, so requiring the canonical form
 *  avoids carrying a full literal grammar without ever blocking a value.
 *
 *  Decimal syntax is validated without coercing through JS `Number` (so an
 *  arbitrary-precision `numeric` is not false-rejected); range / precision is
 *  then checked from the type modifier (`numeric(p,s)`) or the float range. */
function valueFitsType(base: string, dataType: string, value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === '') return false;
  const bounds = INTEGER_BOUNDS[base];
  if (bounds !== undefined) {
    if (!isPlainInteger(trimmed)) return false;
    const n = BigInt(trimmed);
    return n >= bounds[0] && n <= bounds[1];
  }
  if (DECIMAL_BASE_TYPES.has(base)) {
    const lc = trimmed.toLowerCase();
    if (lc === 'nan') return true; // NaN is valid for every decimal/float type, incl. numeric(p,s)
    if (SPECIAL_FLOAT_LITERALS.has(lc)) {
      // ±Infinity: the float types accept it; numeric accepts it only when
      // unbounded — a numeric(p,s) rejects an infinite value (PostgreSQL 22003,
      // not 22P02), so a typmod'd numeric must still 400 here, not 500.
      if (base === 'numeric' || base === 'decimal') return numericTypmod(dataType) === null;
      return true;
    }
    if (!isLexicalDecimal(trimmed)) return false;
    return decimalFitsRange(base, dataType, trimmed);
  }
  if (base === 'boolean' || base === 'bool') {
    return BOOLEAN_LITERALS.has(trimmed.toLowerCase());
  }
  if (base === 'uuid') {
    return isUuidLexical(trimmed);
  }
  return true;
}

/** Whether {@link valueFitsType} actually checks `base` (rather than passing it
 *  through unvalidated). Only these scalar families have a reliable, locale-
 *  independent lexical form: the integer widths, the decimal/float family,
 *  boolean, and uuid. Other types (text, date/time, json, ...) are *not*
 *  pre-checked — their accepted input is too lenient or context-dependent to
 *  validate without risking a false rejection, so they fall through to
 *  PostgreSQL. Callers that validate arbitrary values (id segments, write-body
 *  values) must gate on this so that, e.g., an empty string for a `text`
 *  column is never rejected (it is valid; `valueFitsType` returns `false` for
 *  an empty string only because empty is invalid for the families it checks). */
function isPreflightableScalar(base: string): boolean {
  return (
    INTEGER_BOUNDS[base] !== undefined ||
    DECIMAL_BASE_TYPES.has(base) ||
    base === 'boolean' ||
    base === 'bool' ||
    base === 'uuid'
  );
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
  const type = preflightType(column);
  const base = baseScalarType(type);
  if (base === null) return; // array etc. — not value-checked here
  const values = filter.op === 'in' ? filter.values : [filter.value];
  for (const value of values) {
    if (!valueFitsType(base, type, value)) {
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
  if ((filter.op === 'like' || filter.op === 'ilike') && !isTextLikeType(preflightType(column))) {
    throw badRequest(
      `Operator "${filter.op}" requires a text-like column; "${filter.column}" on resource ` +
        `"${resource.name}" is ${column.dataType}.`,
    );
  }
  if (
    filter.op === 'is' &&
    (filter.keyword === 'true' || filter.keyword === 'false') &&
    !isBooleanType(preflightType(column))
  ) {
    throw badRequest(
      `Filter "is.${filter.keyword}" requires a boolean column; "${filter.column}" on resource ` +
        `"${resource.name}" is ${column.dataType}.`,
    );
  }
}

/**
 * Reject an item-id segment whose component(s) cannot parse as the primary-key
 * column type(s), with a 400 before the query runs (issue #110). Mirrors the
 * list-filter pre-flight (`assertFilterValueParsable`): only the scalar
 * families with a reliable lexical form (integer / decimal / boolean / uuid)
 * are checked; other key types (text, ...) fall through to PostgreSQL. The
 * value is bound straight into the key WHERE clause, so a 400 here is
 * unambiguously client-caused — no server/view error is masked. `keyColumns`
 * and `keyValues` are aligned by index (the caller has enforced matching
 * arity). Without this, an invalid id (`GET /authors/not-a-uuid`) reaches
 * PostgreSQL and raises a data exception (22P02), which is deliberately left
 * as a 500 by the error classifier.
 */
function assertKeyValuesParsable(
  resource: Resource,
  keyColumns: string[],
  keyValues: string[],
): void {
  const columnsByName = new Map(resource.columns.map((c) => [c.name, c]));
  for (let i = 0; i < keyColumns.length; i++) {
    const column = columnsByName.get(keyColumns[i]);
    if (column === undefined) continue; // key column absent from the exposed column set
    const type = preflightType(column);
    const base = baseScalarType(type);
    if (base === null || !isPreflightableScalar(base)) continue;
    if (!valueFitsType(base, type, keyValues[i])) {
      throw badRequest(
        `Item id component "${keyValues[i]}" is not valid for primary-key column ` +
          `"${keyColumns[i]}" (${column.dataType}) on resource "${resource.name}".`,
      );
    }
  }
}

/**
 * Reject a write-body value whose scalar form cannot parse as the target
 * column type, with a 400 before the INSERT/UPDATE runs (issue #110). Only
 * **string-valued** body fields are checked, against the same scalar families
 * the list filters pre-flight (integer / decimal / boolean / uuid): a JSON
 * string is the form in which a malformed scalar reaches the API (`{"id":
 * "zzz"}` for a uuid column). Non-string JSON values are left to PostgreSQL — a
 * JS number is already a valid numeric literal, `null` is a SQL NULL (a NOT
 * NULL violation maps to 400 separately), and an object/array targets a
 * json/array column. Column names have already been validated by
 * `assertKnownColumns`.
 */
function assertWriteValuesParsable(resource: Resource, data: Record<string, unknown>): void {
  const columnsByName = new Map(resource.columns.map((c) => [c.name, c]));
  for (const [key, value] of Object.entries(data)) {
    if (typeof value !== 'string') continue;
    const column = columnsByName.get(key);
    if (column === undefined) continue; // unknown columns already rejected upstream
    const type = preflightType(column);
    const base = baseScalarType(type);
    if (base === null || !isPreflightableScalar(base)) continue;
    if (!valueFitsType(base, type, value)) {
      throw badRequest(
        `Value "${value}" is not valid for column "${key}" (${column.dataType}) ` +
          `on resource "${resource.name}".`,
      );
    }
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
 *  columns whose real type is an array / non-text scalar — the base-type guard
 *  keeps `?search=` from emitting an ILIKE that PostgreSQL rejects (Kozou v1.0
 *  issue #76). A DOMAIN column is judged by its resolved base type
 *  (`preflightType`), so a domain over text is searchable while a domain over
 *  numeric is not (issue #85) — otherwise a domain-over-text column would be
 *  silently dropped and `?search=` would return unfiltered rows. */
function searchableColumns(resource: Resource): string[] {
  return resource.columns
    .filter(
      (c) => (c.widget === 'text' || c.widget === 'textarea') && isTextLikeType(preflightType(c)),
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
 *
 * Each resolved component is pre-flighted against its key column type
 * (issue #110), so an invalid id returns 400 up front instead of a 500.
 */
function resolveKeyValues(resource: Resource, id: string, keyColumns: string[]): string[] {
  let keyValues: string[];
  if (keyColumns.length === 1) {
    keyValues = [id];
  } else {
    const parts = id.split(',');
    if (parts.length !== keyColumns.length) {
      throw badRequest(
        `Resource "${resource.name}" has a composite primary key (${keyColumns.join(', ')}); ` +
          `expected ${keyColumns.length} comma-separated key components, got ${parts.length}.`,
      );
    }
    keyValues = parts;
  }
  assertKeyValuesParsable(resource, keyColumns, keyValues);
  return keyValues;
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
  /** First primary-key column. For a composite-key resource this is only the
   *  first component — read {@link primaryKeys} instead. */
  primaryKey: string;
  /** All primary-key columns, in declaration order. Optional so pre-composite
   *  object shapes stay valid; readers normalize with `?? [primaryKey]`. */
  primaryKeys?: string[];
  labelField: string;
};

/** Primary-key columns for the relation-options (`as=options`) mode. The
 *  option `id` is built from the key, so a key-less resource (a view, or a
 *  table without a primary key) has no options to offer. */
function relationKeyColumns(resource: Resource): string[] {
  if (resource.primaryKey.length === 0) {
    throw badRequest(
      `Resource "${resource.name}" has no primary key; relation options are unavailable.`,
    );
  }
  return resource.primaryKey;
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
  assertWriteValuesParsable(resource, data);

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
  assertWriteValuesParsable(resource, data);
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
  const keyColumns = relationKeyColumns(resource);
  assertKnownColumns(resource, [params.labelField, ...params.searchFields]);

  // `searchFields` is request-controlled (`?as=options&fields=`); each is
  // ILIKE'd below, so reject a non-text-like field with a 400 rather than
  // letting PostgreSQL raise an operator error (a 500) at execution
  // (Kozou v1.0 issue #76).
  const columnsByName = new Map(resource.columns.map((c) => [c.name, c]));
  for (const field of params.searchFields) {
    const column = columnsByName.get(field);
    if (column !== undefined && !isTextLikeType(preflightType(column))) {
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

  const selectFields = keyColumns.includes(params.labelField)
    ? keyColumns
    : [...keyColumns, params.labelField];
  const cols = selectFields.map(quoteIdent).join(', ');
  const text = `SELECT ${cols} FROM ${qualified(resource)}${where} LIMIT ${limitParam}`;

  return {
    text,
    values,
    primaryKey: keyColumns[0],
    primaryKeys: keyColumns,
    labelField: params.labelField,
  };
}
