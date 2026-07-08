import { z } from 'zod';

export const armIds = ['A0', 'A1', 'A2'] as const;

/** Benchmark arm: the only independent variable is the database context
 *  handed to the agent.
 *  - A0: raw DDL (system-catalog facts only; no comments, no view definitions)
 *  - A1: A0 plus verbatim COMMENT text (no interpretation) — Phase 2 arm
 *  - A2: Kozou-compiled context (real `kozou mcp` describe-tool output)
 */
export type ArmId = (typeof armIds)[number];

const numericScoringSchema = z.object({
  kind: z.literal('numeric'),
  expected: z.number(),
  /** Absolute tolerance for float comparison. Default 0.005 (sub-cent). */
  tolerance: z.number().positive().optional(),
});

const textScoringSchema = z.object({
  kind: z.literal('text'),
  expected: z.string().min(1),
  /** Additional accepted spellings, compared case-insensitively. */
  aliases: z.array(z.string().min(1)).optional(),
});

const stringSetScoringSchema = z.object({
  kind: z.literal('string_set'),
  expected: z.array(z.string().min(1)).min(1),
});

export const scoringSchema = z.discriminatedUnion('kind', [
  numericScoringSchema,
  textScoringSchema,
  stringSetScoringSchema,
]);

export const benchTaskSchema = z.object({
  id: z.string().min(1),
  category: z.enum(['source-of-truth', 'soft-delete', 'status-enum', 'control']),
  question: z.string().min(1),
  /** Instruction fragment describing the required result shape of the SQL. */
  result_shape: z.string().min(1),
  scoring: scoringSchema,
  /** Ground-truth SQL, executed against the fixture in CI to verify
   *  `scoring.expected` (see test/groundtruth.test.ts). */
  canonical_sql: z.string().min(1),
  /** Pre-registered trap description and expected direction. */
  trap: z.string().min(1),
});

export const taskSetSchema = z.object({
  tasks: z.array(benchTaskSchema).min(1),
});

export type Scoring = z.infer<typeof scoringSchema>;
export type BenchTask = z.infer<typeof benchTaskSchema>;
