import type { Client } from 'pg';
import type { FkAction, RawForeignKey } from '@kozou/core';
import { runQuery } from './errors.js';

type ForeignKeyRow = {
  schema: string;
  table: string;
  name: string;
  columns: string[];
  referenced_schema: string;
  referenced_table: string;
  referenced_columns: string[];
  on_delete: string;
  on_update: string;
  comment: string | null;
};

const ACTION_MAP: Record<string, FkAction> = {
  a: 'NO ACTION',
  r: 'RESTRICT',
  c: 'CASCADE',
  n: 'SET NULL',
  d: 'SET DEFAULT',
};

function mapAction(code: string): FkAction {
  return ACTION_MAP[code] ?? 'NO ACTION';
}

export async function fetchForeignKeys(
  client: Client,
  schemas: string[],
): Promise<Map<string, RawForeignKey[]>> {
  const result = new Map<string, RawForeignKey[]>();
  if (schemas.length === 0) return result;

  const rows = await runQuery<ForeignKeyRow>(
    client,
    `SELECT
       n.nspname AS schema,
       c.relname AS table,
       con.conname AS name,
       (
         SELECT array_agg(a.attname ORDER BY ord.n)::text[]
         FROM unnest(con.conkey) WITH ORDINALITY AS ord(attnum, n)
         JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ord.attnum
       ) AS columns,
       rn.nspname AS referenced_schema,
       rc.relname AS referenced_table,
       (
         SELECT array_agg(a.attname ORDER BY ord.n)::text[]
         FROM unnest(con.confkey) WITH ORDINALITY AS ord(attnum, n)
         JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = ord.attnum
       ) AS referenced_columns,
       con.confdeltype AS on_delete,
       con.confupdtype AS on_update,
       d.description AS comment
     FROM pg_constraint con
     JOIN pg_class c ON c.oid = con.conrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     JOIN pg_class rc ON rc.oid = con.confrelid
     JOIN pg_namespace rn ON rn.oid = rc.relnamespace
     LEFT JOIN pg_description d ON d.objoid = con.oid AND d.classoid = 'pg_constraint'::regclass
     WHERE con.contype = 'f'
       AND n.nspname = ANY($1)
     ORDER BY n.nspname, c.relname, con.conname`,
    [schemas],
    'fetchForeignKeys',
  );

  for (const row of rows) {
    const key = `${row.schema}.${row.table}`;
    if (!result.has(key)) result.set(key, []);
    result.get(key)!.push({
      name: row.name,
      columns: row.columns ?? [],
      referencedSchema: row.referenced_schema,
      referencedTable: row.referenced_table,
      referencedColumns: row.referenced_columns ?? [],
      onDelete: mapAction(row.on_delete),
      onUpdate: mapAction(row.on_update),
      comment: row.comment,
    });
  }

  return result;
}
