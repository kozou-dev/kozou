import { z } from 'zod';

// ---------------------------------------------------------------------------
// Arms — the only independent variable is the database context the agent gets
// and how it gets it. All gated arms run the SAME agentic tool-use loop; they
// differ only in the tools exposed and what those tools return.
// ---------------------------------------------------------------------------

export const armIds = ['A', 'B', 'C', 'B-flat'] as const;
export type ArmId = (typeof armIds)[number];

/**
 * - A      : comment-less. Tools return raw DDL only (columns/types/constraints
 *            and view definitions). Models a naive integration on a bare schema.
 * - B      : strongest realistic generic MCP. Tools return raw DDL + verbatim
 *            COMMENT text (tables/columns/views/constraints) and a full-text
 *            search over all comments. No interpretation (no @ai/@policy
 *            structuring, no concepts, no derived join purpose).
 * - C      : Kozou. Drives a real `kozou mcp` server via a real MCP client;
 *            the model calls the product's actual tools.
 * - B-flat : companion only (NOT gated). B-style describe of every relation,
 *            concatenated into one context block, answered single-shot. Shows
 *            the arithmetic-trivial token reduction of flat dumps; never used
 *            for the cost gate.
 */
export const GATED_ARMS: readonly ArmId[] = ['A', 'B', 'C'];

// ---------------------------------------------------------------------------
// Scoring (executed against the fixture; ground truth is CI-verified).
// ---------------------------------------------------------------------------

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

export type Scoring = z.infer<typeof scoringSchema>;

// ---------------------------------------------------------------------------
// Task set (pre-registered; frozen before any run).
// ---------------------------------------------------------------------------

export const difficultyTiers = ['D1', 'D2', 'D3'] as const;
export type DifficultyTier = (typeof difficultyTiers)[number];

export const taskCategories = [
  'source-of-truth',
  'soft-delete',
  'status-enum',
  'captured-price',
  'policy',
  'control',
] as const;

export const benchTaskSchema = z.object({
  id: z.string().min(1),
  category: z.enum(taskCategories),
  /** D1 single-relation + one trap, D2 join + trap, D3 multi-hop + combined. */
  difficulty: z.enum(difficultyTiers),
  /** Pure natural-language business question — NEVER mentions schema names. */
  question: z.string().min(1),
  /** Instruction fragment describing the required result shape of the SQL. */
  result_shape: z.string().min(1),
  scoring: scoringSchema,
  /** Ground-truth SQL over the generated fixture; CI-verified at every scale. */
  canonical_sql: z.string().min(1),
  /** Pre-registered trap description and expected direction. */
  trap: z.string().min(1),
  /** True when the naive (comment-less) answer is systematically wrong. Only
   *  strong-trap tasks form the leak-gate denominator (control/weak tasks are
   *  excluded so they cannot inflate arm A's leak-gate score). */
  strong_trap: z.boolean(),
});

export const taskSetSchema = z.object({
  tasks: z.array(benchTaskSchema).min(1),
});

export type BenchTask = z.infer<typeof benchTaskSchema>;

// ---------------------------------------------------------------------------
// Gate task set (tooling validation, not the main comparison). Each task's
// answer is directly stated in a single comment, so a competent generic MCP
// (arm B) that can search + read comments must solve them at a high rate —
// the counterpart to the leak gate, which checks arm A is not too strong.
// ---------------------------------------------------------------------------

export const gateTaskSchema = z.object({
  id: z.string().min(1),
  question: z.string().min(1),
  result_shape: z.string().min(1),
  scoring: scoringSchema,
  canonical_sql: z.string().min(1),
  /** Why B (and C) must solve this if their comment path works. */
  note: z.string().min(1),
});

export const gateTaskSetSchema = z.object({
  tasks: z.array(gateTaskSchema).min(1),
});

export type GateTask = z.infer<typeof gateTaskSchema>;
