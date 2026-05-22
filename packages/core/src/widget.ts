import type { RawColumn } from './types/raw.js';
import type { WidgetType } from './types/context.js';

const NUMERIC_UDT = new Set(['int2', 'int4', 'int8', 'numeric', 'float4', 'float8']);
const DATETIME_UDT = new Set(['timestamp', 'timestamptz', 'time', 'timetz']);
const JSON_UDT = new Set(['json', 'jsonb']);

const URL_HINT_RE = /(?:^|_)url\b|image/i;
const TEXTAREA_HINT_RE = /html|markdown|本文/i;

export type InferWidgetInput = {
  column: RawColumn;
  isForeignKey: boolean;
  enumValues: string[] | null;
  /** parseCommentTags(column.comment).body */
  commentBody: string;
};

export function inferWidget(input: InferWidgetInput): WidgetType {
  const { column, isForeignKey, enumValues, commentBody } = input;
  const udt = column.udtName;

  if (isForeignKey) return 'relation-select';
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
