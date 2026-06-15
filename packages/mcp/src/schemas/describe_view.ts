import { z } from 'zod';
import { relationPrivilegesSchema } from './privileges.js';

export const describeViewInputSchema = z.object({
  qualifiedName: z.string().min(1),
});

const viewColumnSchema = z.object({
  name: z.string(),
  dataType: z.string(),
  nullable: z.boolean(),
  defaultExpr: z.string().nullable(),
  description: z.string().nullable(),
  aiDescription: z.string().nullable(),
  /** `@policy:` lines — advisory business rules for the AI agent. */
  policy: z.array(z.string()),
  enumValues: z.array(z.string()).nullable(),
  isForeignKey: z.boolean(),
  references: z
    .object({
      table: z.string(),
      column: z.string(),
    })
    .nullable(),
});

export const describeViewOutputSchema = z.object({
  qualifiedName: z.string(),
  label: z.string(),
  description: z.string().nullable(),
  aiDescription: z.string().nullable(),
  /** `@policy:` lines on the view COMMENT — advisory, surfaced to the AI agent. */
  policy: z.array(z.string()),
  /** Effective privileges of the evaluated role on this view (privilege-aware
   *  mode). Omitted in the default schema-wide mode. Advisory: enforcement
   *  stays in PostgreSQL. */
  privileges: relationPrivilegesSchema.optional(),
  columns: z.array(viewColumnSchema),
  underlyingTables: z.array(z.string()),
  definition: z.string(),
});

export type DescribeViewInput = z.infer<typeof describeViewInputSchema>;
export type DescribeViewOutput = z.infer<typeof describeViewOutputSchema>;
