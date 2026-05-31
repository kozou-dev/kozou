// Shared test scaffolding. Not a test file (no *.test.ts suffix), so
// vitest does not run it as a suite; it is only typechecked + imported.

import type { ColumnContext, WidgetType, SchemaContext, TableContext, ViewContext } from '@kozou/core';
import type { Resource } from '../src/schema-lookup.js';
import type { Queryable } from '../src/handler.js';

export function col(
  name: string,
  widget: WidgetType = 'text',
  extra: Partial<ColumnContext> = {},
): ColumnContext {
  return {
    name,
    dataType: widget === 'uuid' ? 'uuid' : 'text',
    nullable: true,
    defaultExpr: null,
    isPrimaryKey: false,
    isForeignKey: false,
    label: name,
    description: null,
    aiDescription: null,
    widget,
    enumValues: null,
    readonly: false,
    ...extra,
  };
}

export function tableResource(
  name: string,
  columns: ColumnContext[],
  primaryKey: string[] = ['id'],
  schema = 'public',
): Resource {
  return { kind: 'table', schema, name, qualifiedName: `${schema}.${name}`, columns, primaryKey };
}

export function viewResource(name: string, columns: ColumnContext[], schema = 'public'): Resource {
  return { kind: 'view', schema, name, qualifiedName: `${schema}.${name}`, columns, primaryKey: [] };
}

/** A SchemaContext with only the fields buildResourceLookup reads. */
export function schemaOf(
  tables: { schema?: string; name: string; columns?: ColumnContext[]; primaryKey?: string[] }[],
  views: { schema?: string; name: string; columns?: ColumnContext[] }[] = [],
): SchemaContext {
  return {
    meta: { serverVersion: '16', builtAt: '2026-01-01T00:00:00Z', sourceSchemas: ['public'] },
    tables: tables.map(
      (t) =>
        ({
          schema: t.schema ?? 'public',
          name: t.name,
          qualifiedName: `${t.schema ?? 'public'}.${t.name}`,
          columns: t.columns ?? [],
          primaryKey: t.primaryKey ?? ['id'],
        }) as unknown as TableContext,
    ),
    views: views.map(
      (v) =>
        ({
          schema: v.schema ?? 'public',
          name: v.name,
          qualifiedName: `${v.schema ?? 'public'}.${v.name}`,
          columns: v.columns ?? [],
        }) as unknown as ViewContext,
    ),
    enums: [],
    concepts: [],
  } as unknown as SchemaContext;
}

export type RecordedCall = { text: string; values: unknown[] };

export type RowSet = { rows: Record<string, unknown>[]; rowCount: number | null };

/**
 * A fake Queryable that records every call and returns whatever the
 * `respond` callback produces for the given SQL text. Use the `count(*)`
 * marker in the text to distinguish the count query from the data query.
 */
export function recordingDb(respond: (text: string, values: unknown[]) => RowSet): {
  db: Queryable;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const db = {
    query: async (text: string, values?: unknown[]): Promise<RowSet> => {
      const v = values ?? [];
      calls.push({ text, values: v });
      return respond(text, v);
    },
  } as unknown as Queryable;
  return { db, calls };
}
