import type { SchemaContext } from '@kozou/core';
import {
  describeFunctionsInputSchema,
  type DescribeFunctionsOutput,
} from '../schemas/describe_functions.js';

export function describeFunctions(
  input: Record<string, unknown>,
  ctx: SchemaContext,
): DescribeFunctionsOutput {
  describeFunctionsInputSchema.parse(input);
  return {
    functions: (ctx.functions ?? []).map((fn) => ({
      qualifiedName: fn.qualifiedName,
      label: fn.label,
      description: fn.description,
      aiDescription: fn.aiDescription,
      policy: fn.policy ?? [],
      volatility: fn.volatility,
      security: fn.security,
      publicCallable: fn.publicCallable,
      args: fn.args.map((arg) => ({
        name: arg.name,
        typeName: arg.typeName,
        hasDefault: arg.hasDefault,
        enumValues: arg.enumValues ?? null,
        relation: arg.relation
          ? `${arg.relation.schema}.${arg.relation.table}.${arg.relation.column}`
          : null,
        widget: arg.widget,
      })),
      returns: {
        kind: fn.returns.kind,
        typeName: fn.returns.typeName,
        columns: fn.returns.columns
          ? fn.returns.columns.map((c) => ({ name: c.name, typeName: c.typeName }))
          : null,
      },
    })),
  };
}
