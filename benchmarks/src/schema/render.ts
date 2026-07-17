// Render resolved schema structures to PostgreSQL DDL.
//
// Emits, in order: the read-only `analyst` role, tables (with PK/UNIQUE/FK
// constraints), views, and all COMMENT ON statements (table/column/view and —
// importantly for arm C — FK constraint comments, which Kozou surfaces as
// join purpose). Comments are emitted verbatim; they are the only place
// business meaning lives.

import type { ResolvedTable, ResolvedView } from './domain.js';

function sqlComment(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}

function renderTableDdl(t: ResolvedTable): string {
  const lines: string[] = [];
  for (const c of t.columns) {
    const parts = [`  ${c.name} ${c.type}`];
    if (c.pk) parts.push('PRIMARY KEY');
    if (c.notNull && !c.pk) parts.push('NOT NULL');
    if (c.unique && !c.pk) parts.push('UNIQUE');
    if (c.default !== undefined) parts.push(`DEFAULT ${c.default}`);
    lines.push(parts.join(' '));
  }
  for (const fk of t.fks) {
    lines.push(
      `  CONSTRAINT ${fk.name} FOREIGN KEY (${fk.column}) REFERENCES ${fk.refTable} (${fk.refColumn})`,
    );
  }
  return `CREATE TABLE ${t.name} (\n${lines.join(',\n')}\n);`;
}

function renderComments(t: ResolvedTable): string[] {
  const out: string[] = [];
  if (t.comment) out.push(`COMMENT ON TABLE ${t.name} IS ${sqlComment(t.comment)};`);
  for (const c of t.columns) {
    if (c.comment) out.push(`COMMENT ON COLUMN ${t.name}.${c.name} IS ${sqlComment(c.comment)};`);
  }
  for (const fk of t.fks) {
    if (fk.comment) {
      out.push(`COMMENT ON CONSTRAINT ${fk.name} ON ${t.name} IS ${sqlComment(fk.comment)};`);
    }
  }
  return out;
}

function renderView(v: ResolvedView): string[] {
  const out = [`CREATE VIEW ${v.name} AS\n  ${v.definition};`];
  if (v.comment) out.push(`COMMENT ON VIEW ${v.name} IS ${sqlComment(v.comment)};`);
  return out;
}

export interface RenderInput {
  tables: ResolvedTable[];
  views: ResolvedView[];
  seedStatements: string[];
}

/**
 * Assemble the full fixture SQL.
 *
 * The read-only `analyst` role is created idempotently (roles are
 * cluster-global; a shared CI server may already have it), then granted
 * USAGE + SELECT so it can read every table and view — a realistic
 * non-owner reporting role. Enforcement stays in PostgreSQL, as in the
 * shipped demo.
 */
export function renderFixtureSql(input: RenderInput): string {
  const sections: string[] = [];

  sections.push(
    `DO $$
BEGIN
  CREATE ROLE analyst NOLOGIN;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;`,
  );

  // DDL: tables first (views may depend on them), then views (renderView
  // emits the view's own COMMENT), then the table/column/FK comments, then
  // the seed. GRANTs are added by the loader against the target schema (see
  // fixture.ts), so nothing here assumes `public`.
  for (const t of input.tables) sections.push(renderTableDdl(t));
  for (const v of input.views) sections.push(...renderView(v));
  for (const t of input.tables) {
    const cs = renderComments(t);
    if (cs.length) sections.push(cs.join('\n'));
  }
  sections.push(...input.seedStatements);

  return sections.join('\n\n') + '\n';
}
