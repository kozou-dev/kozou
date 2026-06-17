import { z } from 'zod';

export const listViewsInputSchema = z.object({
  schema: z.string().optional(),
});

export const listViewsOutputSchema = z.object({
  /** The schemas that were introspected (from SchemaContext.meta). Lets a
   *  caller see the scope without guessing — and disambiguate `views: []`. */
  sourceSchemas: z.array(z.string()),
  /** True when the requested schema is not one of `sourceSchemas`: the empty
   *  `views` then means "not looking there", not "nothing here". False for an
   *  introspected schema that genuinely has no views. */
  outOfScope: z.boolean(),
  views: z.array(
    z.object({
      qualifiedName: z.string(),
      label: z.string(),
      purpose: z.string().nullable(),
    }),
  ),
});

export type ListViewsInput = z.infer<typeof listViewsInputSchema>;
export type ListViewsOutput = z.infer<typeof listViewsOutputSchema>;
