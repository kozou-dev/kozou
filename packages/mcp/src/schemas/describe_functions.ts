import { z } from 'zod';

// describe_functions (issue #103): return the signature +
// COMMENT of every exposed RPC function so an AI agent knows what business
// actions it can take and how to call them. No input (like list_concepts);
// rejects extra fields. The agent's advisory metadata (`@ai` / `@policy`) is
// surfaced verbatim so the schema author can warn about side effects.

export const describeFunctionsInputSchema = z.strictObject({});

const functionArgSchema = z.object({
  name: z.string(),
  /** SQL type rendering, e.g. "uuid", "integer", "public.order_status". */
  typeName: z.string(),
  /** When true the argument has a DEFAULT and may be omitted from the call. */
  hasDefault: z.boolean(),
  /** ENUM members, when the argument's type is an enum. */
  enumValues: z.array(z.string()).nullable(),
  /** Relation target ("schema.table.column") for a relation-select argument. */
  relation: z.string().nullable(),
  /** Inferred form widget (advisory; mirrors the Admin UI inference). */
  widget: z.string(),
});

const functionReturnSchema = z.object({
  kind: z.enum(['scalar', 'composite', 'setof', 'void']),
  typeName: z.string(),
  /** Columns of a composite / SETOF row, when resolvable. */
  columns: z.array(z.object({ name: z.string(), typeName: z.string() })).nullable(),
});

export const describeFunctionsOutputSchema = z.object({
  functions: z.array(
    z.object({
      qualifiedName: z.string(),
      label: z.string(),
      description: z.string().nullable(),
      /** `@ai:` notes — advisory guidance for the agent (e.g. "not idempotent"). */
      aiDescription: z.string().nullable(),
      /** `@policy:` business rules — advisory, never enforced by kozou. */
      policy: z.array(z.string()),
      volatility: z.enum(['immutable', 'stable', 'volatile']),
      security: z.enum(['invoker', 'definer']),
      /** Whether PUBLIC may call it (an intentionally public endpoint). */
      publicCallable: z.boolean(),
      args: z.array(functionArgSchema),
      returns: functionReturnSchema,
    }),
  ),
});

export type DescribeFunctionsInput = z.infer<typeof describeFunctionsInputSchema>;
export type DescribeFunctionsOutput = z.infer<typeof describeFunctionsOutputSchema>;
