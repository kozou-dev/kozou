// Parse Kozou v0.1 COMMENT tag conventions (`@ai:`, `@widget:`,
// `@policy:`, `@example:`). See Kozou v0.1 design spec §10.1 for the
// tag vocabulary and §7.3.6 for the `exampleQueries` MCP surface.
//
// `@ai:`, `@policy:`, and `@example:` are multi-line: the tag line
// carries the first value (may be empty), and indented continuation
// lines extend it. A blank line, a non-indented line, or the next
// `@tag:` terminates the block.
//   - `@ai:` / `@policy:` capture the whole block (first line plus
//     trimmed continuation lines, joined) as a single entry, so a
//     multi-line note is not truncated to its first line. The lines
//     stay in `body` too (forward compat, like a single-line tag).
//   - `@example:` collects indented continuation lines as the SQL body;
//     the shared leading indent is stripped so `sql` reads as written,
//     and the block is lifted out of `body` because it is surfaced
//     separately via `examples`.

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

type Pending =
  | { kind: 'example'; description: string; sqlLines: string[] }
  // `@ai:` / `@policy:` blocks: `lines[0]` is the tag-line value; any
  // indented, non-blank continuation lines (trimmed) are appended so a
  // multi-line note is captured whole, not just its first line.
  | { kind: 'ai' | 'policy'; lines: string[] };

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
  let pending: Pending | null = null;

  function flushPending() {
    if (pending === null) return;
    if (pending.kind === 'example') {
      result.examples.push({
        description: pending.description,
        sql: dedent(pending.sqlLines).replace(/\s+$/, ''),
      });
    } else {
      const text = pending.lines.join('\n').trim();
      if (pending.kind === 'ai') result.ai.push(text);
      else result.policy.push(text);
    }
    pending = null;
  }

  for (const line of lines) {
    // Continue an open block before treating the line as body / a tag.
    if (pending !== null) {
      if (pending.kind === 'example') {
        // Indented (or blank) lines extend the SQL body. A blank line is
        // kept so multi-statement examples can include separators.
        if (line.length === 0 || INDENT_RE.test(line)) {
          pending.sqlLines.push(line);
          continue;
        }
      } else if (
        // `@ai:` / `@policy:` continue onto indented, non-blank lines
        // (up to the next tag, a blank line, or a non-indented line).
        // Continuation lines stay in `body` too, like the tag line.
        line.trim().length > 0 &&
        INDENT_RE.test(line) &&
        !TAG_RE.test(line)
      ) {
        pending.lines.push(line.trim());
        bodyLines.push(line);
        continue;
      }
      // Anything else ends the block; re-process this line below.
      flushPending();
    }

    const match = TAG_RE.exec(line);
    if (!match) {
      bodyLines.push(line);
      continue;
    }
    const tag = match[1]!.toLowerCase();
    const value = match[2]!.trim();

    if (tag === 'ai') {
      bodyLines.push(line);
      pending = { kind: 'ai', lines: [value] };
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
      bodyLines.push(line);
      pending = { kind: 'policy', lines: [value] };
      continue;
    }
    if (tag === 'example') {
      // Open an example block. The continuation collector above keeps
      // pushing indented lines into `sqlLines` until the next non-
      // indented line, the next tag, or the end of the comment.
      pending = { kind: 'example', description: value, sqlLines: [] };
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
