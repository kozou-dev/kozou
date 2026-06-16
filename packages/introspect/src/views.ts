import type { Client } from 'pg';
import type { RawColumn, RawView } from '@kozou/core';
import { runQuery } from './errors.js';

type ViewRow = {
  schema: string;
  name: string;
  comment: string | null;
  definition: string;
};

type ViewColumnRow = {
  schema: string;
  view: string;
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

type ViewDependencyRow = {
  view_schema: string;
  view_name: string;
  dep_schema: string;
  dep_name: string;
};

// `fetchViews` returns ordinary views (relkind 'v') and materialized views
// (relkind 'm'). A materialized view is treated like a read-only view: it has a
// defining query (`pg_get_viewdef` works) and columns, and Kozou surfaces no
// write path for either. `pg_get_viewdef` also resolves a matview's `_RETURN`
// rule, so the dependency query can attribute its underlying tables.
export async function fetchViews(client: Client, schemas: string[]): Promise<RawView[]> {
  if (schemas.length === 0) return [];

  const viewRows = await runQuery<ViewRow>(
    client,
    `SELECT
       n.nspname AS schema,
       c.relname AS name,
       d.description AS comment,
       pg_get_viewdef(c.oid, true) AS definition
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     LEFT JOIN pg_description d ON d.objoid = c.oid AND d.objsubid = 0
     WHERE c.relkind IN ('v', 'm')
       AND n.nspname = ANY($1)
     ORDER BY n.nspname, c.relname`,
    [schemas],
    'fetchViews (view list)',
  );

  if (viewRows.length === 0) return [];

  const columnRows = await runQuery<ViewColumnRow>(
    client,
    `SELECT
       n.nspname AS schema,
       c.relname AS view,
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
     WHERE c.relkind IN ('v', 'm')
       AND n.nspname = ANY($1)
       AND a.attnum > 0
       AND NOT a.attisdropped
     ORDER BY n.nspname, c.relname, a.attnum`,
    [schemas],
    'fetchViews (columns)',
  );

  const depRows = await runQuery<ViewDependencyRow>(
    client,
    `SELECT DISTINCT
       view_ns.nspname AS view_schema,
       view_cls.relname AS view_name,
       dep_ns.nspname AS dep_schema,
       dep_cls.relname AS dep_name
     FROM pg_rewrite rw
     JOIN pg_class view_cls ON view_cls.oid = rw.ev_class
     JOIN pg_namespace view_ns ON view_ns.oid = view_cls.relnamespace
     JOIN pg_depend d ON d.objid = rw.oid AND d.classid = 'pg_rewrite'::regclass
     JOIN pg_class dep_cls ON dep_cls.oid = d.refobjid AND d.refclassid = 'pg_class'::regclass
     JOIN pg_namespace dep_ns ON dep_ns.oid = dep_cls.relnamespace
     WHERE view_ns.nspname = ANY($1)
       AND view_cls.relkind IN ('v', 'm')
       AND dep_cls.relkind IN ('r','v','m')
       AND dep_cls.oid <> view_cls.oid
     ORDER BY view_ns.nspname, view_cls.relname, dep_ns.nspname, dep_cls.relname`,
    [schemas],
    'fetchViews (dependencies)',
  );

  const viewKey = (schema: string, name: string) => `${schema}.${name}`;

  const columnsByView = new Map<string, RawColumn[]>();
  for (const row of columnRows) {
    const key = viewKey(row.schema, row.view);
    if (!columnsByView.has(key)) columnsByView.set(key, []);
    columnsByView.get(key)!.push({
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

  const depsByView = new Map<string, { schema: string; name: string }[]>();
  for (const row of depRows) {
    const key = viewKey(row.view_schema, row.view_name);
    if (!depsByView.has(key)) depsByView.set(key, []);
    depsByView.get(key)!.push({ schema: row.dep_schema, name: row.dep_name });
  }

  return viewRows.map<RawView>((row) => {
    const key = viewKey(row.schema, row.name);
    return {
      schema: row.schema,
      name: row.name,
      comment: row.comment,
      columns: columnsByView.get(key) ?? [],
      underlyingTables: depsByView.get(key) ?? [],
      definition: row.definition,
    };
  });
}
