import { z } from 'zod';

export const listConceptsInputSchema = z.object({}).strict();

export const listConceptsOutputSchema = z.object({
  concepts: z.array(
    z.object({
      name: z.string(),
      label: z.string(),
      description: z.string().nullable(),
      kind: z.literal('VIEW'),
    }),
  ),
});

export type ListConceptsInput = z.infer<typeof listConceptsInputSchema>;
export type ListConceptsOutput = z.infer<typeof listConceptsOutputSchema>;
