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

  const referencesByField = new Map<string, { table: string; column: string }>();
  for (const rel of table.relations) {
    referencesByField.set(rel.field, {
      table: `${rel.references.schema}.${rel.references.table}`,
      column: rel.references.column,
    });
  }

  const columns: DescribeTableColumn[] = table.columns.map((c) => ({
    name: c.name,
    dataType: c.dataType,
    nullable: c.nullable,
    defaultExpr: c.defaultExpr,
    description: c.description,
    aiDescription: c.aiDescription,
    enumValues: c.enumValues,
    isForeignKey: c.isForeignKey,
    references: referencesByField.get(c.name) ?? null,
  }));

  return {
    qualifiedName: table.qualifiedName,
    label: table.label,
    description: table.description,
    aiDescription: table.aiDescription,
    primaryKey: table.primaryKey,
    columns,
    relations: table.relations.map((r) => ({
      field: r.field,
      referencesTable: `${r.references.schema}.${r.references.table}`,
      referencesColumn: r.references.column,
      meaning: r.meaning,
    })),
    checkConstraints: table.rawTable.checks.map((c) => ({
      name: c.name,
      expression: c.expression,
    })),
  };
}
