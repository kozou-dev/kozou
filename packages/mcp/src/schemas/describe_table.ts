import { z } from 'zod';

export const describeTableInputSchema = z.object({
  qualifiedName: z.string().min(1),
});

const columnSchema = z.object({
  name: z.string(),
  dataType: z.string(),
  nullable: z.boolean(),
  defaultExpr: z.string().nullable(),
  description: z.string().nullable(),
  aiDescription: z.string().nullable(),
  enumValues: z.array(z.string()).nullable(),
  isForeignKey: z.boolean(),
  references: z
    .object({
      table: z.string(),
      column: z.string(),
    })
    .nullable(),
});

const relationSchema = z.object({
  field: z.string(),
  referencesTable: z.string(),
  referencesColumn: z.string(),
  meaning: z.string().nullable(),
});

const checkConstraintSchema = z.object({
  name: z.string(),
  expression: z.string(),
});

export const describeTableOutputSchema = z.object({
  qualifiedName: z.string(),
  label: z.string(),
  description: z.string().nullable(),
  aiDescription: z.string().nullable(),
  primaryKey: z.array(z.string()),
  columns: z.array(columnSchema),
  relations: z.array(relationSchema),
  checkConstraints: z.array(checkConstraintSchema),
});

export type DescribeTableInput = z.infer<typeof describeTableInputSchema>;
export type DescribeTableOutput = z.infer<typeof describeTableOutputSchema>;
export type DescribeTableColumn = z.infer<typeof columnSchema>;
