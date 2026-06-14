import { z } from 'zod';

// Input schema for the `call` execution tool: a schema-qualified function name
// and an optional object of named arguments. The argument *values* are
// validated downstream by the shared RPC pre-flight + PostgreSQL, not here.
// strictObject so an unexpected top-level key is a clear input error.
export const callInputSchema = z.strictObject({
  function: z.string().min(1),
  args: z.record(z.string(), z.unknown()).optional(),
});

export type CallInput = z.infer<typeof callInputSchema>;
