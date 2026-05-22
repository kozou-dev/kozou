import { z } from 'zod';

export const getConceptContextInputSchema = z.object({
  name: z.string().min(1),
});

const joinSuggestionSchema = z.object({
  table: z.string(),
  on: z.string(),
  purpose: z.string(),
});

const exampleQuerySchema = z.object({
  description: z.string(),
  sql: z.string(),
});

export const getConceptContextOutputSchema = z.object({
  name: z.string(),
  label: z.string(),
  description: z.string().nullable(),
  aiNotes: z.array(z.string()),
  preferredQuerySource: z.string(),
  joinSuggestions: z.array(joinSuggestionSchema),
  relatedTables: z.array(z.string()),
  exampleQueries: z.array(exampleQuerySchema),
});

export type GetConceptContextInput = z.infer<typeof getConceptContextInputSchema>;
export type GetConceptContextOutput = z.infer<typeof getConceptContextOutputSchema>;
