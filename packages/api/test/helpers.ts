// Shared test scaffolding. Not a test file (no *.test.ts suffix), so
// vitest does not run it as a suite; it is only typechecked + imported.

import type {
  ColumnContext,
  WidgetType,
  SchemaContext,
  TableContext,
  ViewContext,
  RelationContext,
} from '@kozou/core';
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

export function relation(
  field: string,
  table: string,
  opts: { schema?: string; column?: string; cardinality?: 'many-to-one' | 'one-to-one' } = {},
): RelationContext {
  return {
    field,
    references: { schema: opts.schema ?? 'public', table, column: opts.column ?? 'id' },
    cardinality: opts.cardinality ?? 'many-to-one',
    meaning: null,
  };
}

export function tableResource(
  name: string,
  columns: ColumnContext[],
  primaryKey: string[] = ['id'],
  schema = 'public',
  relations: RelationContext[] = [],
): Resource {
  return {
    kind: 'table',
    schema,
    name,
    qualifiedName: `${schema}.${name}`,
    columns,
    primaryKey,
    relations,
  };
}

export function viewResource(name: string, columns: ColumnContext[], schema = 'public'): Resource {
  return {
    kind: 'view',
    schema,
    name,
    qualifiedName: `${schema}.${name}`,
    columns,
    primaryKey: [],
    relations: [],
  };
}

type TableSpec = {
  schema?: string;
  name: string;
  columns?: ColumnContext[];
  primaryKey?: string[];
  label?: string;
  description?: string | null;
  aiDescription?: string | null;
  relations?: RelationContext[];
};
type ViewSpec = Omit<TableSpec, 'primaryKey'>;

/** A SchemaContext carrying the fields the lookup + OpenAPI builder read. */
export function schemaOf(tables: TableSpec[], views: ViewSpec[] = []): SchemaContext {
  return {
    meta: { serverVersion: '16', builtAt: '2026-01-01T00:00:00Z', sourceSchemas: ['public'] },
    tables: tables.map(
      (t) =>
        ({
          schema: t.schema ?? 'public',
          name: t.name,
          qualifiedName: `${t.schema ?? 'public'}.${t.name}`,
          label: t.label ?? t.name,
          description: t.description ?? null,
          aiDescription: t.aiDescription ?? null,
          columns: t.columns ?? [],
          primaryKey: t.primaryKey ?? ['id'],
          relations: t.relations ?? [],
        }) as unknown as TableContext,
    ),
    views: views.map(
      (v) =>
        ({
          schema: v.schema ?? 'public',
          name: v.name,
          qualifiedName: `${v.schema ?? 'public'}.${v.name}`,
          label: v.label ?? v.name,
          description: v.description ?? null,
          aiDescription: v.aiDescription ?? null,
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
