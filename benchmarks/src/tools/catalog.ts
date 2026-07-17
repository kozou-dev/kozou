// SQL-backed catalog tools for arms A and B.
//
// These implement a GENERIC database-introspection MCP: exactly what a naive
// integration (A) or a strong generic MCP (B) would offer. A returns raw DDL
// only; B additionally returns verbatim COMMENT text and a full-text comment
// search. Everything is read from the PostgreSQL system catalogs against the
// fixture schema — no Kozou interpretation.

import type { Client } from 'pg';

export interface RelationRef {
  name: string;
}

interface ColumnRow {
  attname: string;
  coltype: string;
  notnull: boolean;
  coldefault: string | null;
  comment: string | null;
}

interface ConstraintRow {
  conname: string;
  condef: string;
  comment: string | null;
}

const COLUMNS_SQL = `
  SELECT a.attname,
         format_type(a.atttypid, a.atttypmod) AS coltype,
         a.attnotnull AS notnull,
         pg_get_expr(d.adbin, d.adrelid) AS coldefault,
         col_description(c.oid, a.attnum) AS comment
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
  ORDER BY a.attnum
`;

const CONSTRAINTS_SQL = `
  SELECT con.conname,
         pg_get_constraintdef(con.oid) AS condef,
         obj_description(con.oid, 'pg_constraint') AS comment
  FROM pg_constraint con
  JOIN pg_class c ON c.oid = con.conrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = $1 AND c.relname = $2
  ORDER BY con.conname
`;

const REL_COMMENT_SQL = `
  SELECT obj_description(c.oid, 'pg_class') AS comment
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = $1 AND c.relname = $2
`;

const VIEWDEF_SQL = `
  SELECT pg_get_viewdef(c.oid, true) AS def
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = $1 AND c.relname = $2
`;

/** List base tables (relkind 'r') or views ('v') in the schema. */
export async function listRelations(
  client: Client,
  schema: string,
  kind: 'r' | 'v',
): Promise<RelationRef[]> {
  const res = await client.query<{ relname: string }>(
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relkind = $2 ORDER BY c.relname`,
    [schema, kind],
  );
  return res.rows.map((r) => ({ name: r.relname }));
}

async function relationExists(client: Client, schema: string, name: string): Promise<boolean> {
  const res = await client.query(
    `SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r','v')`,
    [schema, name],
  );
  return res.rowCount === 1;
}

export interface DescribeOptions {
  /** B includes verbatim comments; A does not. */
  includeComments: boolean;
  /** Views additionally show their definition (both A and B — it is DDL). */
  includeViewDef: boolean;
}

/** Describe a relation as a `\d`-style text block. Throws if it does not
 *  exist (so the tool can return an actionable error to the model). */
export async function describeRelation(
  client: Client,
  schema: string,
  name: string,
  opts: DescribeOptions,
): Promise<string> {
  if (!(await relationExists(client, schema, name))) {
    throw new Error(`relation "${name}" not found in schema "${schema}"`);
  }
  const [cols, cons] = await Promise.all([
    client.query<ColumnRow>(COLUMNS_SQL, [schema, name]),
    client.query<ConstraintRow>(CONSTRAINTS_SQL, [schema, name]),
  ]);

  const lines: string[] = [`RELATION ${name}`];
  for (const c of cols.rows) {
    const parts = [`  ${c.attname} ${c.coltype}`];
    if (c.notnull) parts.push('NOT NULL');
    if (c.coldefault !== null) parts.push(`DEFAULT ${c.coldefault}`);
    if (opts.includeComments && c.comment) parts.push(`-- ${c.comment.replace(/\n/g, ' ')}`);
    lines.push(parts.join(' '));
  }
  for (const con of cons.rows) {
    const parts = [`  CONSTRAINT ${con.conname} ${con.condef}`];
    if (opts.includeComments && con.comment) parts.push(`-- ${con.comment.replace(/\n/g, ' ')}`);
    lines.push(parts.join(' '));
  }

  if (opts.includeViewDef) {
    const def = await client.query<{ def: string }>(VIEWDEF_SQL, [schema, name]);
    if (def.rows[0]?.def) lines.push(`  VIEW DEFINITION:\n    ${def.rows[0].def.replace(/\n/g, '\n    ')}`);
  }

  if (opts.includeComments) {
    const rel = await client.query<{ comment: string | null }>(REL_COMMENT_SQL, [schema, name]);
    const comment = rel.rows[0]?.comment;
    if (comment) lines.splice(1, 0, `  COMMENT: ${comment.replace(/\n/g, '\n           ')}`);
  }

  return lines.join('\n');
}

interface CommentHit {
  relation: string;
  column: string | null;
  comment: string;
}

/** Full-text (case-insensitive substring) search over ALL comments in the
 *  schema: table, column, view, and constraint comments. Arm B only. */
export async function searchComments(
  client: Client,
  schema: string,
  query: string,
): Promise<string> {
  const q = `%${query}%`;
  const rel = await client.query<{ relname: string; comment: string }>(
    `SELECT c.relname, obj_description(c.oid, 'pg_class') AS comment
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relkind IN ('r','v')
       AND obj_description(c.oid, 'pg_class') ILIKE $2
     ORDER BY c.relname`,
    [schema, q],
  );
  const col = await client.query<{ relname: string; attname: string; comment: string }>(
    `SELECT c.relname, a.attname, col_description(c.oid, a.attnum) AS comment
     FROM pg_attribute a
     JOIN pg_class c ON c.oid = a.attrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relkind IN ('r','v') AND a.attnum > 0 AND NOT a.attisdropped
       AND col_description(c.oid, a.attnum) ILIKE $2
     ORDER BY c.relname, a.attnum`,
    [schema, q],
  );
  const con = await client.query<{ relname: string; conname: string; comment: string }>(
    `SELECT c.relname, con.conname, obj_description(con.oid, 'pg_constraint') AS comment
     FROM pg_constraint con
     JOIN pg_class c ON c.oid = con.conrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND obj_description(con.oid, 'pg_constraint') ILIKE $2
     ORDER BY c.relname, con.conname`,
    [schema, q],
  );

  const hits: CommentHit[] = [
    ...rel.rows.map((r) => ({ relation: r.relname, column: null, comment: r.comment })),
    ...col.rows.map((r) => ({ relation: r.relname, column: r.attname, comment: r.comment })),
    ...con.rows.map((r) => ({ relation: r.relname, column: `constraint ${r.conname}`, comment: r.comment })),
  ];

  if (hits.length === 0) return `No comments match "${query}".`;
  return hits
    .map((h) => `${h.relation}${h.column ? `.${h.column}` : ''}: ${h.comment.replace(/\n/g, ' ')}`)
    .join('\n');
}
