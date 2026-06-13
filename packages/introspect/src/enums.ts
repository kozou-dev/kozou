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
    // enumlabel is the \`name\` type; array_agg would yield a name[] (oid 1003),
    // which node-postgres does not parse into a JS array (it would arrive as the
    // raw "{a,b}" literal). Cast each label to text so the result is a text[]
    // (oid 1009) the driver parses — RawEnum.values is then a real string[], as
    // its type promises and as every consumer (docs renderEnum, RPC enum args)
    // expects.
    `SELECT
       n.nspname AS schema,
       t.typname AS name,
       array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS values
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
