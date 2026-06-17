import type { RowSecurity, SchemaContext } from '@kozou/core';
import { McpToolError } from '../errors.js';
import {
  describeTableInputSchema,
  type DescribeTableInput,
  type DescribeTableOutput,
  type DescribeTableColumn,
} from '../schemas/describe_table.js';

/** Build the human-readable advisory for the row-security signal. Returns a
 *  `note` only when RLS is enabled — a non-RLS table needs no caveat, and the
 *  bare `enabled: false` already says "rows are not filtered". */
function rowSecurityNote(rls: RowSecurity): { note: string } | Record<string, never> {
  if (!rls.enabled) return {};
  const base = rls.hasPolicies
    ? 'Row-level security is enabled: the rows you can read and the rows you can write are ' +
      'filtered by policy for the connecting role, so do not assume a result is complete or ' +
      'that a write will be accepted.'
    : 'Row-level security is enabled but no policy is defined, so non-owner roles can read and ' +
      'write no rows (default-deny).';
  return {
    note: rls.forced
      ? `${base} RLS also applies to the table owner (roles with BYPASSRLS still bypass it).`
      : base,
  };
}

export function describeTable(input: DescribeTableInput, ctx: SchemaContext): DescribeTableOutput {
  const parsed = describeTableInputSchema.parse(input);
  const table = ctx.tables.find((t) => t.qualifiedName === parsed.qualifiedName);
  if (!table) {
    throw new McpToolError(`Table not found: ${parsed.qualifiedName}`);
  }

  // Annotate every FK column with its referenced column. For a composite FK
  // each member column maps to its positionally-aligned referenced column.
  const referencesByField = new Map<string, { table: string; column: string }>();
  for (const rel of table.relations) {
    const refTable = `${rel.references.schema}.${rel.references.table}`;
    const fields = rel.fields ?? [rel.field];
    const refCols = rel.references.columns ?? [rel.references.column];
    fields.forEach((field, i) => {
      referencesByField.set(field, { table: refTable, column: refCols[i]! });
    });
  }

  const columns: DescribeTableColumn[] = table.columns.map((c) => ({
    name: c.name,
    dataType: c.dataType,
    nullable: c.nullable,
    defaultExpr: c.defaultExpr,
    description: c.description,
    aiDescription: c.aiDescription,
    policy: c.policy ?? [],
    enumValues: c.enumValues,
    isForeignKey: c.isForeignKey,
    references: referencesByField.get(c.name) ?? null,
    // Privilege-aware mode only; `undefined` (omitted) when not evaluated.
    ...(c.insertable === undefined ? {} : { insertable: c.insertable }),
    ...(c.updatable === undefined ? {} : { updatable: c.updatable }),
  }));

  return {
    qualifiedName: table.qualifiedName,
    label: table.label,
    description: table.description,
    aiDescription: table.aiDescription,
    policy: table.policy ?? [],
    primaryKey: table.primaryKey,
    // Privilege-aware mode only; omitted when privileges were not evaluated.
    ...(table.privileges ? { privileges: table.privileges } : {}),
    // Row-level security signal; present whenever
    // introspection captured it. The policy expressions are never surfaced.
    ...(table.rowSecurity
      ? { rowSecurity: { ...table.rowSecurity, ...rowSecurityNote(table.rowSecurity) } }
      : {}),
    columns,
    relations: table.relations.map((r) => ({
      field: r.field,
      fields: r.fields ?? [r.field],
      referencesTable: `${r.references.schema}.${r.references.table}`,
      referencesColumn: r.references.column,
      referencesColumns: r.references.columns ?? [r.references.column],
      meaning: r.meaning,
    })),
    checkConstraints: table.rawTable.checks.map((c) => ({
      name: c.name,
      expression: c.expression,
    })),
  };
}
