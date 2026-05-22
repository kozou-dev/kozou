import { z } from 'zod';

export const listTablesInputSchema = z.object({
  schema: z.string().optional(),
  includeSystem: z.boolean().optional(),
});

export const listTablesOutputSchema = z.object({
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
