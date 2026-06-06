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

/** Columns that free-text search targets: text-like widgets only. uuid /
 *  enum / numeric columns are excluded (an `ILIKE` against them either
 *  errors or is meaningless). */
function searchableColumns(resource: Resource): string[] {
  return resource.columns
    .filter((c) => c.widget === 'text' || c.widget === 'textarea')
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
  const columnNames = new Set(resource.columns.map((c) => c.name));

  const whereParts: string[] = [];
  const whereValues: unknown[] = [];
  const nextParam = (): string => `$${whereValues.length + 1}`;

  // Horizontal filters. The column allowlist is the resource's own columns;
  // every supplied value is a bound parameter ($n). `is` emits a fixed
  // keyword clause (no value bound).
  for (const filter of params.filters ?? []) {
    if (!columnNames.has(filter.column)) {
      throw badRequest(`Unknown filter column "${filter.column}" on resource "${resource.name}".`);
    }
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
      if (!columnNames.has(s.field)) {
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
