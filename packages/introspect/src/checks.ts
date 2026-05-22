import type { Client } from 'pg';
import type { RawCheck } from '@kozou/core';
import { runQuery } from './errors.js';

type CheckRow = {
  schema: string;
  table: string;
  name: string;
  definition: string;
};

const CHECK_SKIN_RE = /^CHECK \((.*)\)$/s;

function stripCheckSkin(def: string): string {
  const m = CHECK_SKIN_RE.exec(def);
  return m ? m[1]! : def;
}

export async function fetchChecks(
  client: Client,
  schemas: string[],
): Promise<Map<string, RawCheck[]>> {
  const result = new Map<string, RawCheck[]>();
  if (schemas.length === 0) return result;

  const rows = await runQuery<CheckRow>(
    client,
    `SELECT
       n.nspname AS schema,
       c.relname AS table,
       con.conname AS name,
       pg_get_constraintdef(con.oid, true) AS definition
     FROM pg_constraint con
     JOIN pg_class c ON c.oid = con.conrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE con.contype = 'c'
       AND con.conrelid <> 0
       AND n.nspname = ANY($1)
     ORDER BY n.nspname, c.relname, con.conname`,
    [schemas],
    'fetchChecks',
  );

  for (const row of rows) {
    const key = `${row.schema}.${row.table}`;
    if (!result.has(key)) result.set(key, []);
    result.get(key)!.push({
      name: row.name,
      expression: stripCheckSkin(row.definition),
    });
  }

  return result;
}
