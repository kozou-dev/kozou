// Shared test scaffolding. Not a test file (no *.test.ts suffix), so
// vitest does not run it as a suite; it is only typechecked + imported.

import type {
  ColumnContext,
  WidgetType,
  SchemaContext,
  TableContext,
  ViewContext,
  RelationContext,
  FunctionContext,
  FunctionArgContext,
  FunctionReturnContext,
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
  const schema = opts.schema ?? 'public';
  const column = opts.column ?? 'id';
  return {
    field,
    fields: [field],
    references: { schema, table, column, columns: [column] },
    cardinality: opts.cardinality ?? 'many-to-one',
    meaning: null,
  };
}

/** A composite (multi-column) foreign-key relation. `fields` and
 *  `references.columns` are positionally aligned; the scalar `field` / `column`
 *  keep `[0]` for back-compat. */
export function compositeRelation(
  fields: string[],
  table: string,
  refColumns: string[],
  opts: { schema?: string; cardinality?: 'many-to-one' | 'one-to-one' } = {},
): RelationContext {
  const schema = opts.schema ?? 'public';
  return {
    field: fields[0]!,
    fields: [...fields],
    references: { schema, table, column: refColumns[0]!, columns: [...refColumns] },
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

export function fnArg(
  name: string,
  typeName = 'text',
  extra: Partial<FunctionArgContext> = {},
): FunctionArgContext {
  return { name, typeName, hasDefault: false, widget: 'text', ...extra };
}

/** A FunctionContext for the RPC tests. Defaults to an invoker, void-returning
 *  function with no args. */
export function functionContext(
  name: string,
  opts: {
    schema?: string;
    args?: FunctionArgContext[];
    returns?: FunctionReturnContext;
    security?: 'invoker' | 'definer';
    publicCallable?: boolean;
    volatility?: 'immutable' | 'stable' | 'volatile';
    label?: string;
    description?: string | null;
    aiDescription?: string | null;
    policy?: string[];
  } = {},
): FunctionContext {
  const schema = opts.schema ?? 'public';
  return {
    schema,
    name,
    qualifiedName: `${schema}.${name}`,
    label: opts.label ?? name,
    description: opts.description ?? null,
    aiDescription: opts.aiDescription ?? null,
    policy: opts.policy,
    args: opts.args ?? [],
    returns: opts.returns ?? { kind: 'void', typeName: 'void' },
    volatility: opts.volatility ?? 'volatile',
    security: opts.security ?? 'invoker',
    publicCallable: opts.publicCallable ?? false,
    rawFunction: {} as unknown as FunctionContext['rawFunction'],
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
  policy?: string[];
  relations?: RelationContext[];
};
type ViewSpec = Omit<TableSpec, 'primaryKey'>;

/** A SchemaContext carrying the fields the lookup + OpenAPI builder read. */
export function schemaOf(
  tables: TableSpec[],
  views: ViewSpec[] = [],
  functions: FunctionContext[] = [],
): SchemaContext {
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
          policy: t.policy,
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
          policy: v.policy,
          columns: v.columns ?? [],
        }) as unknown as ViewContext,
    ),
    enums: [],
    concepts: [],
    functions,
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
