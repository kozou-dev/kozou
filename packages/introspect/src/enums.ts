import type { Client } from 'pg';
import type { RawEnum } from '@kozou/core';
import { runQuery } from './errors.js';

type EnumRow = {
  schema: string;
  name: string;
  values: string[];
};

export async function fetchEnums(client: Client, schemas: string[]): Promise<RawEnum[]> {
  if (schemas.length === 0) return [];

  const rows = await runQuery<EnumRow>(
    client,
    `SELECT
       n.nspname AS schema,
       t.typname AS name,
       array_agg(e.enumlabel ORDER BY e.enumsortorder) AS values
     FROM pg_type t
     JOIN pg_namespace n ON n.oid = t.typnamespace
     JOIN pg_enum e ON e.enumtypid = t.oid
     WHERE t.typtype = 'e'
       AND n.nspname = ANY($1)
     GROUP BY n.nspname, t.typname
     ORDER BY n.nspname, t.typname`,
    [schemas],
    'fetchEnums',
  );

  return rows.map<RawEnum>((row) => ({
    schema: row.schema,
    name: row.name,
    values: row.values,
  }));
}
