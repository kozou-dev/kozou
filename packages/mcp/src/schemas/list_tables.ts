import { z } from 'zod';

export const listTablesInputSchema = z.object({
  schema: z.string().optional(),
  /** @deprecated No-op. The introspected schema set is fixed when the schema
   *  context is built, so this could never be honored at call time. It is no
   *  longer advertised by the MCP `list_tables` tool, but is kept (optional,
   *  ignored) in this exported input type so existing TypeScript callers do not
   *  break. Use the `sourceSchemas` / `outOfScope` output fields to reason about
   *  scope instead. */
  includeSystem: z.boolean().optional(),
});

export const listTablesOutputSchema = z.object({
  /** The schemas that were introspected (from SchemaContext.meta). Lets a
   *  caller see the scope without guessing — and disambiguate `tables: []`. */
  sourceSchemas: z.array(z.string()),
  /** True when the requested schema is not one of `sourceSchemas`: the empty
   *  `tables` then means "not looking there", not "nothing here". False for an
   *  introspected schema that genuinely has no tables. */
  outOfScope: z.boolean(),
  tables: z.array(
    z.object({
      qualifiedName: z.string(),
      label: z.string(),
      description: z.string().nullable(),
      rowCountEstimate: z.number().nullable(),
    }),
  ),
});

export type ListTablesInput = z.infer<typeof listTablesInputSchema>;
export type ListTablesOutput = z.infer<typeof listTablesOutputSchema>;
