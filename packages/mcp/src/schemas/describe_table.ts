import { z } from 'zod';
import { relationPrivilegesSchema } from './privileges.js';

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
  /** Privilege-aware mode only: whether the evaluated role may INSERT this
   *  column. Omitted in the default schema-wide mode. */
  insertable: z.boolean().optional(),
  /** Privilege-aware mode only: whether the evaluated role may UPDATE this
   *  column. Omitted in the default schema-wide mode. */
  updatable: z.boolean().optional(),
});

const relationSchema = z.object({
  /** First FK column / referenced column; kept for back-compat. Prefer the
   *  `fields` / `referencesColumns` arrays, which carry the full (possibly
   *  composite) key. */
  field: z.string(),
  fields: z.array(z.string()),
  referencesTable: z.string(),
  referencesColumn: z.string(),
  referencesColumns: z.array(z.string()),
  meaning: z.string().nullable(),
});

const checkConstraintSchema = z.object({
  name: z.string(),
  expression: z.string(),
});

/** Row-level security status of the table. A
 *  role-independent structural signal surfaced unconditionally (unlike the
 *  opt-in per-role `privileges`): it warns the agent that results may be
 *  filtered and writes rejected by the connecting role's policies. The policy
 *  expressions themselves are never read or surfaced (security-sensitive).
 *  Advisory only — PostgreSQL enforces RLS regardless. */
const rowSecuritySchema = z.object({
  enabled: z.boolean(),
  /** RLS also applies to the table owner (`relforcerowsecurity`). */
  forced: z.boolean(),
  /** Whether any policy exists (existence only; expressions are never read).
   *  Enabled with no policy ⇒ default-deny for non-owner roles. */
  hasPolicies: z.boolean(),
  /** Human-readable advisory, present only when `enabled`. */
  note: z.string().optional(),
});

export const describeTableOutputSchema = z.object({
  qualifiedName: z.string(),
  label: z.string(),
  description: z.string().nullable(),
  aiDescription: z.string().nullable(),
  /** `@policy:` lines on the table COMMENT — advisory, surfaced to the AI agent. */
  policy: z.array(z.string()),
  primaryKey: z.array(z.string()),
  /** Effective privileges of the evaluated role on this table (privilege-aware
   *  mode). Omitted in the default schema-wide mode. Advisory: enforcement
   *  stays in PostgreSQL. */
  privileges: relationPrivilegesSchema.optional(),
  /** Row-level security signal. Present whenever
   *  introspection captured it; omitted only for a context built before the
   *  field existed. */
  rowSecurity: rowSecuritySchema.optional(),
  columns: z.array(columnSchema),
  relations: z.array(relationSchema),
  checkConstraints: z.array(checkConstraintSchema),
});

export type DescribeTableInput = z.infer<typeof describeTableInputSchema>;
export type DescribeTableOutput = z.infer<typeof describeTableOutputSchema>;
export type DescribeTableColumn = z.infer<typeof columnSchema>;
