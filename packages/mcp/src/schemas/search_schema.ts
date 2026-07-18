import { z } from 'zod';

/** The kind of schema object a hit points at. `column` covers both table and
 *  view columns; the containing relation is the leading part of `ref`. */
export const searchSchemaKind = z.enum(['table', 'column', 'view', 'function', 'enum']);
export type SearchSchemaKind = z.infer<typeof searchSchemaKind>;

/** Which documentation field the query matched on. `enumValue` is a member of a
 *  native ENUM or a value pulled from a CHECK constraint. A view's `purpose` is
 *  reported as `description`; `@ai:` lines are reported as `aiDescription`. */
export const searchSchemaMatchedField = z.enum([
  'name',
  'label',
  'description',
  'aiDescription',
  'policy',
  'enumValue',
]);
export type SearchSchemaMatchedField = z.infer<typeof searchSchemaMatchedField>;

export const searchSchemaInputSchema = z.object({
  /** Case-insensitive substring to search for. */
  query: z.string().min(1),
  /** Restrict to a single schema (matches the object's schema; a view's columns
   *  follow the view). Omitted ⇒ every introspected schema. */
  schema: z.string().optional(),
  /** Restrict to these object kinds. Omitted ⇒ all kinds. */
  kinds: z.array(searchSchemaKind).min(1).optional(),
  /** Max hits to return (ranked; the truncation is the low-scoring tail).
   *  Default 20, capped at 100 by the handler. */
  limit: z.number().int().positive().optional(),
});

export const searchSchemaHitSchema = z.object({
  kind: searchSchemaKind,
  /** The identifier to feed the next tool: `schema.table` (table),
   *  `schema.relation.column` (column), `schema.view` (view),
   *  `schema.function` (function), `schema.enumtype` (enum). */
  ref: z.string(),
  /** Human label of the object (its `label`, or its name when unlabeled). */
  label: z.string(),
  matchedField: searchSchemaMatchedField,
  /** The matching text, whitespace-collapsed and windowed around the match for
   *  long fields (elided with `…`). */
  snippet: z.string(),
  /** Relevance score (field weight + match-quality bonus); higher is better.
   *  Advisory ranking only — not a stable contract to compute against. */
  score: z.number(),
});

export const searchSchemaOutputSchema = z.object({
  query: z.string(),
  /** True when more objects matched than `limit` returned. */
  truncated: z.boolean(),
  hits: z.array(searchSchemaHitSchema),
});

export type SearchSchemaInput = z.infer<typeof searchSchemaInputSchema>;
export type SearchSchemaHit = z.infer<typeof searchSchemaHitSchema>;
export type SearchSchemaOutput = z.infer<typeof searchSchemaOutputSchema>;
