// UIHints type definitions + zod schema.
//
// In v0.1 we treat the TypeScript shape here as the minimal source of
// truth and validate the parsed YAML with zod from loadUIHints.
//
// Extension surface: when v0.2 adds relations or validation rules, extend
// this schema here.

import { z } from 'zod';

import type { WidgetType } from './context.js';

const widgetTypeSchema = z.enum([
  'text',
  'textarea',
  'number',
  'boolean',
  'date',
  'datetime',
  'enum-select',
  'relation-select',
  'json',
  'image-url',
  'uuid',
  'currency',
]) satisfies z.ZodType<WidgetType>;

const relationHintsSchema = z.object({
  labelField: z.string().min(1).optional(),
  searchFields: z.array(z.string().min(1)).optional(),
});

const columnHintsSchema = z.object({
  label: z.string().min(1).optional(),
  widget: widgetTypeSchema.optional(),
  readonly: z.boolean().optional(),
  /** Used for relation rendering; only meaningful when widget = relation-select */
  relation: relationHintsSchema.optional(),
});

const tableHintsSchema = z.object({
  label: z.string().min(1).optional(),
  displayField: z.string().min(1).optional(),
  columns: z.record(z.string(), columnHintsSchema).optional(),
});

const viewHintsSchema = z.object({
  label: z.string().min(1).optional(),
  columns: z.record(z.string(), columnHintsSchema).optional(),
});

/** Top-level zod schema for UIHints YAML. Used by loadUIHints.
 *
 *  Keys are relation names. A bare name (`users`) matches that relation in any
 *  schema and is the common single-schema form; a schema-qualified key
 *  (`audit.users`) is preferred during lookup, so two same-named relations in
 *  different schemas can each carry their own hints without colliding (see
 *  `lookupHints` in buildSchemaContext). */
export const uiHintsSchema = z.object({
  tables: z.record(z.string(), tableHintsSchema).optional(),
  views: z.record(z.string(), viewHintsSchema).optional(),
});

export type UIHints = z.infer<typeof uiHintsSchema>;
export type TableHints = z.infer<typeof tableHintsSchema>;
export type ColumnHints = z.infer<typeof columnHintsSchema>;
export type ViewHints = z.infer<typeof viewHintsSchema>;
export type RelationHints = z.infer<typeof relationHintsSchema>;
