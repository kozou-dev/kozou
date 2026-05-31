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
import type { Resource } from './schema-lookup.js';

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

export type SortDirection = 'asc' | 'desc';

export type ListQueryParams = {
  page?: number;
  pageSize?: number;
  sort?: { field: string; order: SortDirection }[];
  search?: string;
  /** Column-equality filters. Keys must be declared columns of the resource. */
  filters?: Record<string, string>;
};

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

/** Quote an identifier for safe inlining (defense in depth on top of the allowlist). */
export function quoteIdent(id: string): string {
  return '"' + id.replace(/"/g, '""') + '"';
}

function qualified(resource: Resource): string {
  return `${quoteIdent(resource.schema)}.${quoteIdent(resource.name)}`;
}

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

  // Column-equality filters.
  for (const [key, value] of Object.entries(params.filters ?? {})) {
    if (!columnNames.has(key)) {
      throw badRequest(`Unknown filter column "${key}" on resource "${resource.name}".`);
    }
    whereParts.push(`${quoteIdent(key)} = ${nextParam()}`);
    whereValues.push(value);
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

  const dataValues = [...whereValues, pageSize, offset];
  const limitParam = `$${whereValues.length + 1}`;
  const offsetParam = `$${whereValues.length + 2}`;
  const dataText = `SELECT ${cols} FROM ${table}${whereClause}${orderClause} LIMIT ${limitParam} OFFSET ${offsetParam}`;

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

export function buildGetQuery(resource: Resource, id: string): BuiltGetQuery {
  if (resource.primaryKey.length !== 1) {
    throw badRequest(
      `Resource "${resource.name}" does not have a single-column primary key; fetch-by-id is unavailable.`,
    );
  }
  const pk = resource.primaryKey[0];
  const text = `SELECT ${selectColumns(resource)} FROM ${qualified(resource)} WHERE ${quoteIdent(pk)} = $1 LIMIT 1`;
  return { text, values: [id] };
}
