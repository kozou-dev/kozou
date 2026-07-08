// Arm A0 — "raw DDL": what a naive integration sees.
//
// Mechanical extraction from the system catalogs: relation names, columns
// with types / nullability / defaults, and constraint definitions (PK, FK,
// UNIQUE, CHECK — everything `\d` would show). Deliberately NO comments and
// NO view definitions: this arm models an agent pointed at the bare schema.
// It is "naive but fair" — nothing `\d` shows is withheld.

import type { Client } from 'pg';

interface ColumnRow {
  relname: string;
  relkind: string;
  attname: string;
  coltype: string;
  notnull: boolean;
  coldefault: string | null;
}

interface ConstraintRow {
  relname: string;
  conname: string;
  condef: string;
}

const COLUMNS_SQL = `
  SELECT c.relname,
         c.relkind::text AS relkind,
         a.attname,
         format_type(a.atttypid, a.atttypmod) AS coltype,
         a.attnotnull AS notnull,
         pg_get_expr(d.adbin, d.adrelid) AS coldefault
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE n.nspname = $1
    AND a.attnum > 0
    AND NOT a.attisdropped
    AND c.relkind IN ('r', 'v')
  ORDER BY c.relname, a.attnum
`;

const CONSTRAINTS_SQL = `
  SELECT c.relname,
         con.conname,
         pg_get_constraintdef(con.oid) AS condef
  FROM pg_constraint con
  JOIN pg_class c ON c.oid = con.conrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = $1
  ORDER BY c.relname, con.conname
`;

export async function generateRawDdlContext(
  client: Client,
  schema: string,
): Promise<string> {
  const columns = await client.query<ColumnRow>(COLUMNS_SQL, [schema]);
  const constraints = await client.query<ConstraintRow>(CONSTRAINTS_SQL, [schema]);

  const constraintsByRel = new Map<string, ConstraintRow[]>();
  for (const row of constraints.rows) {
    const list = constraintsByRel.get(row.relname) ?? [];
    list.push(row);
    constraintsByRel.set(row.relname, list);
  }

  const relations = new Map<string, { kind: string; lines: string[] }>();
  for (const row of columns.rows) {
    let rel = relations.get(row.relname);
    if (!rel) {
      rel = { kind: row.relkind === 'v' ? 'VIEW' : 'TABLE', lines: [] };
      relations.set(row.relname, rel);
    }
    const parts = [`  ${row.attname} ${row.coltype}`];
    if (row.notnull) parts.push('NOT NULL');
    if (row.coldefault !== null) parts.push(`DEFAULT ${row.coldefault}`);
    rel.lines.push(parts.join(' '));
  }

  const sections: string[] = [
    `-- Relations in schema "${schema}" (from the PostgreSQL system catalogs).`,
  ];
  for (const [relname, rel] of relations) {
    const body = [...rel.lines];
    for (const con of constraintsByRel.get(relname) ?? []) {
      body.push(`  CONSTRAINT ${con.conname} ${con.condef}`);
    }
    sections.push(`${rel.kind} ${relname}\n${body.join('\n')}`);
  }
  return sections.join('\n\n');
}
