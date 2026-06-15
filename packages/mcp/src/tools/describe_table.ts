import type { SchemaContext } from '@kozou/core';
import {
  describeTableInputSchema,
  type DescribeTableInput,
  type DescribeTableOutput,
  type DescribeTableColumn,
} from '../schemas/describe_table.js';

export function describeTable(input: DescribeTableInput, ctx: SchemaContext): DescribeTableOutput {
  const parsed = describeTableInputSchema.parse(input);
  const table = ctx.tables.find((t) => t.qualifiedName === parsed.qualifiedName);
  if (!table) {
    throw new Error(`Table not found: ${parsed.qualifiedName}`);
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
