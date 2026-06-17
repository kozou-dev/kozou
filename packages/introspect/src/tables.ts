import type { Client } from 'pg';
import type { RawCheck, RawColumn, RawForeignKey, RawIndex, RawTable } from '@kozou/core';
import { runQuery } from './errors.js';

type TableRow = {
  schema: string;
  name: string;
  comment: string | null;
  row_count_estimate: number | null;
};

type ColumnRow = {
  schema: string;
  table: string;
  name: string;
  data_type: string;
  /** `format_type` with one level of DOMAIN resolved to its base type + typmod
   *  (issue #85); equals data_type for non-domain columns. */
  effective_type: string;
  udt_name: string;
  is_nullable: boolean;
  column_default: string | null;
  comment: string | null;
  position: number;
};

type PrimaryKeyRow = {
  schema: string;
  table: string;
  column: string;
  ordinal: number;
};

type IndexRow = {
  schema: string;
  table: string;
  name: string;
  columns: string[];
  is_unique: boolean;
};

// `fetchTables` returns ordinary tables (relkind 'r') and declarative
// partitioned *parent* tables (relkind 'p'), but never the individual
// partitions (`relispartition`): a caller addresses the parent, and a write to
// it is routed to the right partition by PostgreSQL, so surfacing every leaf
// would double the schema and let a write bypass routing. A partitioned parent
// carries its own columns / primary key / constraints, so it reads like a
// normal table downstream.
export async function fetchTables(client: Client, schemas: string[]): Promise<RawTable[]> {
  if (schemas.length === 0) return [];

  const tableRows = await runQuery<TableRow>(
    client,
    // `c.reltuples` is the planner's row-count estimate, maintained by
    // ANALYZE / autovacuum. PostgreSQL uses -1 to mark "never
    // analyzed", which we surface as null so downstream consumers
    // always see "non-negative count or unknown" instead of mixing the
    // sentinel into the numeric domain.
    `SELECT
       n.nspname AS schema,
       c.relname AS name,
       d.description AS comment,
       CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::float8 END AS row_count_estimate
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     LEFT JOIN pg_description d ON d.objoid = c.oid AND d.objsubid = 0
     WHERE c.relkind IN ('r', 'p')
       AND NOT c.relispartition
       AND n.nspname = ANY($1)
     ORDER BY n.nspname, c.relname`,
    [schemas],
    'fetchTables (table list)',
  );

  if (tableRows.length === 0) {
    return [];
  }

  // Membership set for the per-column grouping guard below. The columns query
  // scopes by schema/relkind in SQL but not by table name, so this filters the
  // rows down to the tables we listed; a Set keeps that lookup O(1) rather than
  // O(tables) per column row.
  const tableNameSet = new Set(tableRows.map((r) => r.name));

  const columnRows = await runQuery<ColumnRow>(
    client,
    `SELECT
       n.nspname AS schema,
       c.relname AS table,
       a.attname AS name,
       format_type(a.atttypid, a.atttypmod) AS data_type,
       t.typname AS udt_name,
       -- Resolve one level of DOMAIN to its base type, carrying the domain's own
       -- typmod (so a domain over numeric(12,2) yields 'numeric(12,2)'), so value
       -- pre-flight sees the base type rather than the opaque domain name
       -- (issue #85). A domain over a domain stays a domain name here and is
       -- left unchecked downstream (fail-open for that exotic nesting).
       CASE
         WHEN t.typtype = 'd' AND t.typbasetype <> 0
           THEN format_type(t.typbasetype, t.typtypmod)
         ELSE format_type(a.atttypid, a.atttypmod)
       END AS effective_type,
       NOT a.attnotnull AS is_nullable,
       pg_get_expr(ad.adbin, ad.adrelid) AS column_default,
       d.description AS comment,
       a.attnum::int AS position
     FROM pg_attribute a
     JOIN pg_class c ON c.oid = a.attrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     JOIN pg_type t ON t.oid = a.atttypid
     LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
     LEFT JOIN pg_description d ON d.objoid = a.attrelid AND d.objsubid = a.attnum
     WHERE c.relkind IN ('r', 'p')
       AND NOT c.relispartition
       AND n.nspname = ANY($1)
       AND a.attnum > 0
       AND NOT a.attisdropped
     ORDER BY n.nspname, c.relname, a.attnum`,
    [schemas],
    'fetchTables (columns)',
  );

  const pkRows = await runQuery<PrimaryKeyRow>(
    client,
    `SELECT
       n.nspname AS schema,
       c.relname AS table,
       a.attname AS column,
       ord.n::int AS ordinal
     FROM pg_constraint con
     JOIN pg_class c ON c.oid = con.conrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS ord(attnum, n) ON true
     JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ord.attnum
     WHERE con.contype = 'p'
       AND n.nspname = ANY($1)
     ORDER BY n.nspname, c.relname, ord.n`,
    [schemas],
    'fetchTables (primary keys)',
  );

  const indexRows = await runQuery<IndexRow>(
    client,
    `SELECT
       n.nspname AS schema,
       t.relname AS table,
       ic.relname AS name,
       (
         SELECT array_agg(a.attname ORDER BY ord.n)::text[]
         FROM unnest(ix.indkey) WITH ORDINALITY AS ord(attnum, n)
         JOIN pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = ord.attnum
       ) AS columns,
       ix.indisunique AS is_unique
     FROM pg_index ix
     JOIN pg_class ic ON ic.oid = ix.indexrelid
     JOIN pg_class t ON t.oid = ix.indrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE t.relkind IN ('r', 'p')
       AND NOT t.relispartition
       AND n.nspname = ANY($1)
       AND NOT ix.indisprimary
     ORDER BY n.nspname, t.relname, ic.relname`,
    [schemas],
    'fetchTables (indexes)',
  );

  const tableKey = (schema: string, name: string) => `${schema}.${name}`;
  const columnsByTable = new Map<string, RawColumn[]>();
  for (const row of columnRows) {
    if (!tableNameSet.has(row.table)) continue;
    const key = tableKey(row.schema, row.table);
    if (!columnsByTable.has(key)) columnsByTable.set(key, []);
    columnsByTable.get(key)!.push({
      name: row.name,
      dataType: row.data_type,
      effectiveType: row.effective_type,
      udtName: row.udt_name,
      nullable: row.is_nullable,
      defaultExpr: row.column_default,
      comment: row.comment,
      position: row.position,
    });
  }

  const pkByTable = new Map<string, string[]>();
  for (const row of pkRows) {
    const key = tableKey(row.schema, row.table);
    if (!pkByTable.has(key)) pkByTable.set(key, []);
    pkByTable.get(key)!.push(row.column);
  }

  const indexByTable = new Map<string, RawIndex[]>();
  for (const row of indexRows) {
    const key = tableKey(row.schema, row.table);
    if (!indexByTable.has(key)) indexByTable.set(key, []);
    indexByTable.get(key)!.push({
      name: row.name,
      columns: row.columns ?? [],
      unique: row.is_unique,
    });
  }

  return tableRows.map<RawTable>((row) => {
    const key = tableKey(row.schema, row.name);
    return {
      schema: row.schema,
      name: row.name,
      comment: row.comment,
      columns: columnsByTable.get(key) ?? [],
      primaryKey: pkByTable.get(key) ?? [],
      foreignKeys: [],
      checks: [],
      indexes: indexByTable.get(key) ?? [],
      // pg returns float8 as a JS number; round to integer because
      // the contract types this as `number | null` and a fractional
      // estimate would be misleading at the MCP surface.
      rowCountEstimate:
        row.row_count_estimate === null
          ? null
          : Math.round(row.row_count_estimate),
    };
  });
}

export function mergeTableMetadata(
  tables: RawTable[],
  fks: Map<string, RawForeignKey[]>,
  checks: Map<string, RawCheck[]>,
): void {
  for (const table of tables) {
    const key = `${table.schema}.${table.name}`;
    table.foreignKeys = fks.get(key) ?? [];
    table.checks = checks.get(key) ?? [];
  }
}
