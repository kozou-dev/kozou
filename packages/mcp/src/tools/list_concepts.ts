import type { SchemaContext } from '@kozou/core';
import {
  listConceptsInputSchema,
  type ListConceptsOutput,
} from '../schemas/list_concepts.js';

export function listConcepts(
  input: Record<string, unknown>,
  ctx: SchemaContext,
): ListConceptsOutput {
  listConceptsInputSchema.parse(input);
  return {
    concepts: ctx.concepts.map((c) => ({
      name: c.name,
      label: c.label,
      description: c.description,
      kind: c.kind,
    })),
  };
}
