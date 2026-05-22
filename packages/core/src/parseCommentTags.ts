import type { WidgetType } from './types/context.js';

const KNOWN_WIDGETS: ReadonlySet<WidgetType> = new Set<WidgetType>([
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
]);

const KNOWN_TAGS = new Set(['ai', 'widget', 'policy']);
const TAG_RE = /^\s*@([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/;

export type ParsedComment = {
  body: string;
  ai: string[];
  widget: WidgetType | null;
  policy: string[];
};

function isWidgetType(value: string): value is WidgetType {
  return KNOWN_WIDGETS.has(value as WidgetType);
}

export function parseCommentTags(comment: string | null): ParsedComment {
  const result: ParsedComment = { body: '', ai: [], widget: null, policy: [] };
  if (comment === null || comment === '') return result;

  const lines = comment.split('\n');
  const bodyLines: string[] = [];

  for (const line of lines) {
    const match = TAG_RE.exec(line);
    if (!match) {
      bodyLines.push(line);
      continue;
    }
    const tag = match[1]!.toLowerCase();
    const value = match[2]!.trim();

    if (tag === 'ai') {
      result.ai.push(value);
      bodyLines.push(line);
      continue;
    }
    if (tag === 'widget') {
      if (isWidgetType(value)) {
        result.widget = value;
      } else {
        console.warn(
          `[@kozou/core] parseCommentTags: 無効な @widget 値 "${value}" (skip)`,
        );
        result.widget = null;
      }
      continue;
    }
    if (tag === 'policy') {
      result.policy.push(value);
      bodyLines.push(line);
      continue;
    }
    if (!KNOWN_TAGS.has(tag)) {
      console.warn(
        `[@kozou/core] parseCommentTags: 未定義 tag "@${tag}" (forward compat: body に残置)`,
      );
      bodyLines.push(line);
    }
  }

  result.body = bodyLines.join('\n').replace(/\s+$/, '');
  return result;
}
