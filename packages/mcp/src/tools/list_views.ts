import type { SchemaContext } from '@kozou/core';
import {
  listViewsInputSchema,
  type ListViewsInput,
  type ListViewsOutput,
} from '../schemas/list_views.js';

export function listViews(input: ListViewsInput, ctx: SchemaContext): ListViewsOutput {
  const parsed = listViewsInputSchema.parse(input);
  const schema = parsed.schema ?? 'public';
  // See list_tables: `sourceSchemas` is the configured source set and
  // `outOfScope` true means the requested schema is not in it, so an empty
  // `views` reads as "not looking there" rather than "nothing here".
  const sourceSchemas = ctx.meta.sourceSchemas;
  return {
    sourceSchemas,
    outOfScope: !sourceSchemas.includes(schema),
    views: ctx.views
      .filter((v) => v.schema === schema)
      .map((v) => ({
        qualifiedName: v.qualifiedName,
        label: v.label,
        purpose: v.purpose,
      })),
  };
}
