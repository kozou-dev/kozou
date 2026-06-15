import type { SchemaContext } from '@kozou/core';
import {
  describeViewInputSchema,
  type DescribeViewInput,
  type DescribeViewOutput,
} from '../schemas/describe_view.js';

export function describeView(input: DescribeViewInput, ctx: SchemaContext): DescribeViewOutput {
  const parsed = describeViewInputSchema.parse(input);
  const view = ctx.views.find((v) => v.qualifiedName === parsed.qualifiedName);
  if (!view) {
    throw new Error(`View not found: ${parsed.qualifiedName}`);
  }
  return {
    qualifiedName: view.qualifiedName,
    label: view.label,
    description: view.description,
    aiDescription: view.aiDescription,
    policy: view.policy ?? [],
    // Privilege-aware mode only; omitted when privileges were not evaluated.
    ...(view.privileges ? { privileges: view.privileges } : {}),
    columns: view.columns.map((c) => ({
      name: c.name,
      dataType: c.dataType,
      nullable: c.nullable,
      defaultExpr: c.defaultExpr,
      description: c.description,
      aiDescription: c.aiDescription,
      policy: c.policy ?? [],
      enumValues: c.enumValues,
      isForeignKey: c.isForeignKey,
      references: null,
    })),
    underlyingTables: view.underlyingTables.map((t) => `${t.schema}.${t.name}`),
    definition: view.rawView.definition,
  };
}
