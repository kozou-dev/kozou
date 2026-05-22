import type { SchemaContext } from '@kozou/core';
import {
  listViewsInputSchema,
  type ListViewsInput,
  type ListViewsOutput,
} from '../schemas/list_views.js';

export function listViews(input: ListViewsInput, ctx: SchemaContext): ListViewsOutput {
  const parsed = listViewsInputSchema.parse(input);
  const schema = parsed.schema ?? 'public';
  return {
    views: ctx.views
      .filter((v) => v.schema === schema)
      .map((v) => ({
        qualifiedName: v.qualifiedName,
        label: v.label,
        purpose: v.purpose,
      })),
  };
}
