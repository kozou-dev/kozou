// Parse Kozou v0.1 COMMENT tag conventions (`@ai:`, `@widget:`,
// `@policy:`, `@example:`). See Kozou v0.1 design spec §10.1 for the
// tag vocabulary and §7.3.6 for the `exampleQueries` MCP surface.
//
// `@example:` is the only multi-line tag in v0.1: the line itself
// carries the human-facing description (may be empty), and any
// indented continuation lines form the SQL body. The first non-
// indented line (or another `@tag:`) terminates the block, and the
// shared leading indent across continuation lines is stripped so the
// resulting `sql` reads as written without the COMMENT-imposed
// indent. The block is lifted out of `body` because the SQL is
// surfaced separately via `examples`.

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

const KNOWN_TAGS = new Set(['ai', 'widget', 'policy', 'example']);
const TAG_RE = /^\s*@([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/;
const INDENT_RE = /^[ \t]/;

export type ExampleQuery = {
  description: string;
  sql: string;
};

export type ParsedComment = {
  body: string;
  ai: string[];
  widget: WidgetType | null;
  policy: string[];
  examples: ExampleQuery[];
};

function isWidgetType(value: string): value is WidgetType {
  return KNOWN_WIDGETS.has(value as WidgetType);
}

interface PendingExample {
  description: string;
  sqlLines: string[];
}

export function parseCommentTags(comment: string | null): ParsedComment {
  const result: ParsedComment = {
    body: '',
    ai: [],
    widget: null,
    policy: [],
    examples: [],
  };
  if (comment === null || comment === '') return result;

  const lines = comment.split('\n');
  const bodyLines: string[] = [];
  let pending: PendingExample | null = null;

  function flushPending() {
    if (pending === null) return;
    result.examples.push({
      description: pending.description,
      sql: dedent(pending.sqlLines).replace(/\s+$/, ''),
    });
    pending = null;
  }

  for (const line of lines) {
    // Inside an `@example:` block: indented (or blank) lines extend the
    // SQL body. An empty line is treated as part of the SQL paragraph
    // so callers can include blank separators inside multi-statement
    // examples.
    if (pending !== null) {
      if (line.length === 0 || INDENT_RE.test(line)) {
        pending.sqlLines.push(line);
        continue;
      }
      // Non-indented line ends the example.
      flushPending();
      // Fall through to handle this line normally.
    }

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
          `[@kozou/core] parseCommentTags: invalid @widget value "${value}" (skip)`,
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
    if (tag === 'example') {
      // Open an example block. The continuation collector above keeps
      // pushing indented lines into `sqlLines` until the next non-
      // indented line, the next tag, or the end of the comment.
      pending = { description: value, sqlLines: [] };
      continue;
    }
    if (!KNOWN_TAGS.has(tag)) {
      console.warn(
        `[@kozou/core] parseCommentTags: unknown tag "@${tag}" (forward compat: kept in body)`,
      );
      bodyLines.push(line);
    }
  }
  flushPending();

  result.body = bodyLines.join('\n').replace(/\s+$/, '');
  return result;
}

/** Strip the longest common leading whitespace from every non-empty
 *  line so multi-line SQL reads as written rather than indented by
 *  the COMMENT block. Blank lines are preserved as empty strings. */
function dedent(lines: string[]): string {
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  if (nonEmpty.length === 0) return lines.join('\n');

  let commonPrefix = leadingWhitespace(nonEmpty[0]!);
  for (const line of nonEmpty.slice(1)) {
    const prefix = leadingWhitespace(line);
    let i = 0;
    while (
      i < commonPrefix.length &&
      i < prefix.length &&
      commonPrefix[i] === prefix[i]
    ) {
      i++;
    }
    commonPrefix = commonPrefix.slice(0, i);
    if (commonPrefix.length === 0) break;
  }

  if (commonPrefix.length === 0) return lines.join('\n');
  return lines
    .map((l) => (l.startsWith(commonPrefix) ? l.slice(commonPrefix.length) : l))
    .join('\n');
}

function leadingWhitespace(line: string): string {
  const match = line.match(/^[ \t]*/);
  return match ? match[0] : '';
}
