import type { SchemaContext } from '@kozou/core';
import {
  getConceptContextInputSchema,
  type GetConceptContextInput,
  type GetConceptContextOutput,
} from '../schemas/get_concept_context.js';

export function getConceptContext(
  input: GetConceptContextInput,
  ctx: SchemaContext,
): GetConceptContextOutput {
  const parsed = getConceptContextInputSchema.parse(input);
  const concept = ctx.concepts.find((c) => c.name === parsed.name);
  if (!concept) {
    throw new Error(`Concept not found: ${parsed.name}`);
  }
  const view = ctx.views.find((v) => v.name === concept.name);
  const relatedTables = view ? view.underlyingTables.map((t) => `${t.schema}.${t.name}`) : [];
  return {
    name: concept.name,
    label: concept.label,
    description: concept.description,
    aiNotes: concept.aiNotes,
    preferredQuerySource: `FROM ${concept.name}`,
    joinSuggestions: concept.joinSuggestions.map((j) => ({
      table: j.table,
      on: j.on,
      purpose: '',
    })),
    relatedTables,
    exampleQueries: [],
  };
}
