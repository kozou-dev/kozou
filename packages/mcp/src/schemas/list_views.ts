import { z } from 'zod';

export const listViewsInputSchema = z.object({
  schema: z.string().optional(),
});

export const listViewsOutputSchema = z.object({
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
