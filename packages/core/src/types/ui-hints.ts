// Kozou v0.1 spec §4.3 の UIHints 型定義 + zod schema。
//
// Kozou v0.1 spec §16.1 で「UI Hints YAML の最終文法は実装中に確定」と意図的に open
// にされている open item。v0.1 では本書 §4.3 の TypeScript shape を最小限の
// 正本とし、loadUIHints での YAML パース後に zod で validation する。
//
// 拡張余地: v0.2 で関係や validation rule 等を追加する場合は本 schema を
// 拡張し、Kozou v0.1 spec §4.3 を同 PR で更新する (§0 規約)。

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
  /** relation 表示用 (relation-select 時のみ意味を持つ) */
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

/** UIHints YAML の最上位 zod schema。loadUIHints で使用。 */
export const uiHintsSchema = z.object({
  tables: z.record(z.string(), tableHintsSchema).optional(),
  views: z.record(z.string(), viewHintsSchema).optional(),
});

export type UIHints = z.infer<typeof uiHintsSchema>;
export type TableHints = z.infer<typeof tableHintsSchema>;
export type ColumnHints = z.infer<typeof columnHintsSchema>;
export type ViewHints = z.infer<typeof viewHintsSchema>;
export type RelationHints = z.infer<typeof relationHintsSchema>;
