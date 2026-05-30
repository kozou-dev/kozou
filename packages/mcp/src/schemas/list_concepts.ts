import { z } from 'zod';

// No inputs; reject any extra fields. zod 4 infers a strict empty object as
// `Record<string, never>`, so the tool fn takes the raw `Record<string,
// unknown>` args and validates them through this schema rather than typing
// its parameter as the inferred (and unassignable) empty-object type.
export const listConceptsInputSchema = z.strictObject({});

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
