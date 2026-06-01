// Map a ColumnContext to the TypeScript type that best describes the value a
// client receives from @kozou/api — i.e. the JSON shape after node-postgres
// has parsed the row and the response has been serialized. This is why a few
// mappings may surprise: node-postgres returns `numeric` and `bigint` as
// strings (to avoid precision loss), and temporal types arrive as ISO strings
// once a Date has gone through JSON.stringify.
//
// Input is the `dataType` produced by @kozou/introspect via PostgreSQL's
// `format_type(...)`, so the names are the SQL-standard long forms
// ("character varying", "timestamp with time zone", "double precision", …),
// optionally carrying a precision/length and a trailing `[]` for arrays.

import type { ColumnContext } from '@kozou/core';

/** A column with an enum domain renders as a union of string literals; every
 *  other column maps by its PostgreSQL `dataType`. The result never includes
 *  `| null` — the caller appends that based on `nullable`. */
export function mapColumnType(column: ColumnContext): string {
  if (column.enumValues && column.enumValues.length > 0) {
    return column.enumValues.map(quoteStringLiteral).join(' | ');
  }
  return mapDataType(column.dataType);
}

/** Map a `format_type(...)` string to a TypeScript type, resolving any array
 *  suffix to `T[]` and stripping precision/length modifiers first. */
export function mapDataType(dataType: string): string {
  let base = dataType.trim();

  // Peel a (single-level) array suffix; PostgreSQL renders multi-dimensional
  // arrays with the same element type, so `T[]` is the faithful TS shape.
  let isArray = false;
  while (base.endsWith('[]')) {
    isArray = true;
    base = base.slice(0, -2).trim();
  }

  // Drop every `(...)` modifier ("numeric(12,2)", "timestamp(6) with time
  // zone", "character varying(255)") and normalize whitespace + case.
  const normalized = base
    .replace(/\([^)]*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

  const element = SCALAR_TYPE_MAP[normalized] ?? 'unknown';
  return isArray ? `${element}[]` : element;
}

const SCALAR_TYPE_MAP: Record<string, string> = {
  // Textual + identifier types.
  uuid: 'string',
  text: 'string',
  'character varying': 'string',
  character: 'string',
  '"char"': 'string',
  bpchar: 'string',
  citext: 'string',
  name: 'string',

  // Integers and floats fit in a JS number.
  smallint: 'number',
  integer: 'number',
  real: 'number',
  'double precision': 'number',

  // node-postgres returns these as strings to preserve precision/range.
  numeric: 'string',
  bigint: 'string',

  boolean: 'boolean',

  // Temporal values arrive as ISO strings once a Date is JSON-serialized.
  date: 'string',
  'timestamp without time zone': 'string',
  'timestamp with time zone': 'string',
  'time without time zone': 'string',
  'time with time zone': 'string',
  interval: 'string',

  // Structured payloads are parsed objects of an unknown shape.
  json: 'unknown',
  jsonb: 'unknown',
};

/** Render a string as a single-quoted TypeScript string literal, escaping the
 *  backslash and single-quote characters. */
export function quoteStringLiteral(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}
