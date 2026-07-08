// Arm A1 — "raw COMMENT pass-through": models a competitor that reads the
// same COMMENT text but does none of Kozou's interpretation.
//
// A0's catalog facts plus the verbatim pg_description strings, concatenated
// with no parsing: no @ai / @policy structuring, no views-as-concepts, no
// recommended query paths, no privilege signal. (Phase 2 arm — implemented
// so the harness is arm-pluggable; Phase 1 runs A0 vs A2.)

import type { Client } from 'pg';

import { generateRawDdlContext } from './a0RawDdl.js';

interface RelCommentRow {
  relname: string;
  comment: string;
}

interface ColCommentRow {
  relname: string;
  attname: string;
  comment: string;
}

const REL_COMMENTS_SQL = `
  SELECT c.relname, obj_description(c.oid, 'pg_class') AS comment
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = $1
    AND c.relkind IN ('r', 'v')
    AND obj_description(c.oid, 'pg_class') IS NOT NULL
  ORDER BY c.relname
`;

const COL_COMMENTS_SQL = `
  SELECT c.relname, a.attname, col_description(c.oid, a.attnum) AS comment
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = $1
    AND a.attnum > 0
    AND NOT a.attisdropped
    AND c.relkind IN ('r', 'v')
    AND col_description(c.oid, a.attnum) IS NOT NULL
  ORDER BY c.relname, a.attnum
`;

export async function generateRawCommentContext(
  client: Client,
  schema: string,
): Promise<string> {
  const ddl = await generateRawDdlContext(client, schema);
  const relComments = await client.query<RelCommentRow>(REL_COMMENTS_SQL, [schema]);
  const colComments = await client.query<ColCommentRow>(COL_COMMENTS_SQL, [schema]);

  const sections: string[] = [
    ddl,
    '-- Raw comments (verbatim pg_description text, no interpretation).',
  ];
  for (const row of relComments.rows) {
    sections.push(`COMMENT ON ${row.relname}:\n${row.comment}`);
  }
  for (const row of colComments.rows) {
    sections.push(`COMMENT ON ${row.relname}.${row.attname}:\n${row.comment}`);
  }
  return sections.join('\n\n');
}
