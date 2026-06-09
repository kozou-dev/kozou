import type { RawColumn } from './types/raw.js';
import type { WidgetType } from './types/context.js';

const NUMERIC_UDT = new Set(['int2', 'int4', 'int8', 'numeric', 'float4', 'float8']);
const DATETIME_UDT = new Set(['timestamp', 'timestamptz', 'time', 'timetz']);
const JSON_UDT = new Set(['json', 'jsonb']);

const URL_HINT_RE = /(?:^|_)url\b|image/i;
const TEXTAREA_HINT_RE = /html|markdown|body|content/i;

export type InferWidgetInput = {
  column: RawColumn;
  isForeignKey: boolean;
  /** Whether this column is the sole column of a single-column foreign key, so
   *  a relation-select picker has one value to resolve. Composite-FK columns
   *  are foreign keys (`isForeignKey: true`) but are not relation-selectable on
   *  their own, so they fall through to a type-based widget. Defaults to
   *  `isForeignKey` when omitted (back-compat). Added in v1.1. */
  relationSelectable?: boolean;
  enumValues: string[] | null;
  /** parseCommentTags(column.comment).body */
  commentBody: string;
};

export function inferWidget(input: InferWidgetInput): WidgetType {
  const { column, isForeignKey, relationSelectable, enumValues, commentBody } = input;
  const udt = column.udtName;

  if (relationSelectable ?? isForeignKey) return 'relation-select';
  if (enumValues !== null && enumValues.length > 0) return 'enum-select';
  if (udt === 'uuid') return 'uuid';
  if (udt === 'bool') return 'boolean';
  if (NUMERIC_UDT.has(udt)) return 'number';
  if (udt === 'date') return 'date';
  if (DATETIME_UDT.has(udt)) return 'datetime';
  if (JSON_UDT.has(udt)) return 'json';
  if (udt === 'text' && URL_HINT_RE.test(column.name)) return 'image-url';
  if (udt === 'text' && TEXTAREA_HINT_RE.test(commentBody)) return 'textarea';
  return 'text';
}
