// Parse Kozou v0.1 COMMENT tag conventions (`@ai:`, `@widget:`,
// `@policy:`, `@example:`).
//
// Two single-line tags were added for the RPC surface (issue #103):
// `@expose:` marks a function for RPC exposure
// (`@expose: rpc`, or `@expose: rpc public` to keep PUBLIC callable),
// and `@arg: <name> relation(<ref>)` / `@arg: <name> widget(<type>)`
// hints a function argument toward a relation-select / specific widget
// in the Admin UI action form.
//
// Tags are recognized at line start only (after optional leading
// whitespace). A known tag written mid-line is NOT parsed — the text
// stays in `body` verbatim — and emits a warning so the leak into
// OpenAPI / MCP descriptions is not silent.
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

const KNOWN_TAGS = new Set(['ai', 'widget', 'policy', 'example', 'expose', 'arg']);
// Note: no `\s*` after the `:` — the captured value is `.trim()`ed in
// code, and a `\s*` directly before `(.*)` makes this a polynomial-ReDoS
// shape (both match spaces) that CodeQL flags. Leading/intra whitespace
// uses single, non-overlapping `\s*` groups, so matching stays linear.
const TAG_RE = /^\s*@([a-zA-Z_][a-zA-Z0-9_]*)\s*:(.*)$/;
const INDENT_RE = /^[ \t]/;
const LINE_WS_RE = /\s/;

function isIdentStart(code: number): boolean {
  return (
    (code >= 97 && code <= 122) || // a-z
    (code >= 65 && code <= 90) || // A-Z
    code === 95 // _
  );
}

function isIdentChar(code: number): boolean {
  return isIdentStart(code) || (code >= 48 && code <= 57); // + 0-9
}

// Manual scan for `<identifier>\s*:` at a given offset — the tag-token
// shape TAG_RE recognizes, without a regex. This sits on the COMMENT
// dataflow path, where CodeQL flags closure-adjacent regex shapes as
// polynomial-ReDoS (the established workaround in this package is a
// linear character scan). Returns the identifier, or null.
function tagTokenAt(line: string, start: number): string | null {
  let i = start;
  if (i >= line.length || !isIdentStart(line.charCodeAt(i))) return null;
  i += 1;
  while (i < line.length && isIdentChar(line.charCodeAt(i))) i += 1;
  const token = line.slice(start, i);
  while (i < line.length && LINE_WS_RE.test(line[i]!)) i += 1;
  return i < line.length && line[i] === ':' ? token : null;
}

// Tags are recognized at line start only. A *known* tag written mid-line
// is the silent-leak case from the field: it is neither parsed nor
// removed, so the literal tag text flows into `body` (and tag values) and
// from there into OpenAPI / MCP descriptions. Detect it so the loop can
// warn (the same courtesy the invalid-value and unknown-tag paths already
// extend). Single pass: `seenContent` tracks whether any non-whitespace
// precedes the current position, so a line-start `@` (TAG_RE territory)
// never trips it, and no prefix is re-scanned per `@`. Email-style text
// (`user@example.com`) does not trip this: the token must be followed by
// a colon. Unknown tokens (`@todo:`) stay silent — mid-line prose is the
// normal place to mention such things.
function midlineKnownTag(line: string): string | null {
  let seenContent = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (ch === '@' && seenContent) {
      const token = tagTokenAt(line, i + 1);
      if (token !== null && KNOWN_TAGS.has(token.toLowerCase())) {
        return `@${token}:`;
      }
    }
    if (!seenContent && !LINE_WS_RE.test(ch)) seenContent = true;
  }
  return null;
}

function warnMidlineTag(token: string): void {
  console.warn(
    `[@kozou/core] parseCommentTags: mid-line "${token}" is not parsed ` +
      '(tags are recognized at line start only; the text stays in the ' +
      'description verbatim)',
  );
}

export type ExampleQuery = {
  description: string;
  sql: string;
};

/** RPC exposure marker from `@expose:`. `none` = the
 *  function is not exposed (the default); `rpc` = exposed; `rpc-public` =
 *  exposed and intentionally public-callable (PUBLIC EXECUTE override). */
export type ExposeKind = 'none' | 'rpc' | 'rpc-public';

/** Per-argument hint from `@arg: <name> ...` on a function COMMENT.
 *  `relation` targets a relation-select; `widget` forces a widget. The
 *  relation `schema` is null when the ref was 2-part (`table.col`); the
 *  function-context builder defaults it to the function's schema. */
export type ArgHint = {
  name: string;
  relation?: { schema: string | null; table: string; column: string };
  widget?: WidgetType;
};

export type ParsedComment = {
  body: string;
  ai: string[];
  widget: WidgetType | null;
  policy: string[];
  examples: ExampleQuery[];
  /** RPC exposure marker (`@expose:`); `none` when the tag is absent. */
  expose: ExposeKind;
  /** `@arg:` hints, in source order. */
  args: ArgHint[];
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

/** Index of the first whitespace character, or -1. Manual scan (no regex) to
 *  stay off CodeQL's polynomial-ReDoS radar, like the rest of this module. */
function firstWhitespaceIndex(s: string): number {
  for (let i = 0; i < s.length; i += 1) {
    if (LINE_WS_RE.test(s[i]!)) return i;
  }
  return -1;
}

/** Extract `<inner>` from a `<name>(<inner>)` directive token (trimmed), or
 *  null when the token is not exactly that shape. Manual scan, no regex. */
function parenDirective(directive: string, name: string): string | null {
  const prefix = `${name}(`;
  if (!directive.startsWith(prefix) || !directive.endsWith(')')) return null;
  return directive.slice(prefix.length, -1).trim();
}

/** Parse an `@arg:` value — "<argname> relation(<ref>)" or
 *  "<argname> widget(<type>)". Returns null on any malformed shape so the
 *  caller can warn (no silent drop). `<ref>` is `table.col` (schema defaulted
 *  later) or `schema.table.col`. */
function parseArgHint(value: string): ArgHint | null {
  const ws = firstWhitespaceIndex(value);
  if (ws === -1) return null; // bare name, no directive
  const name = value.slice(0, ws);
  const directive = value.slice(ws + 1).trim();
  if (name === '' || directive === '') return null;

  const rel = parenDirective(directive, 'relation');
  if (rel !== null) {
    const parts = rel.split('.').map((p) => p.trim());
    if (parts.length === 2 && parts.every((p) => p !== '')) {
      return { name, relation: { schema: null, table: parts[0]!, column: parts[1]! } };
    }
    if (parts.length === 3 && parts.every((p) => p !== '')) {
      return { name, relation: { schema: parts[0]!, table: parts[1]!, column: parts[2]! } };
    }
    return null;
  }
  const wid = parenDirective(directive, 'widget');
  if (wid !== null) {
    return isWidgetType(wid) ? { name, widget: wid } : null;
  }
  return null;
}

export function parseCommentTags(comment: string | null): ParsedComment {
  const result: ParsedComment = {
    body: '',
    ai: [],
    widget: null,
    policy: [],
    examples: [],
    expose: 'none',
    args: [],
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
        sql: dedent(pending.sqlLines).trimEnd(),
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
        const midline = midlineKnownTag(line);
        if (midline !== null) warnMidlineTag(midline);
        pending.lines.push(line.trim());
        bodyLines.push(line);
        continue;
      }
      // Anything else ends the block; re-process this line below.
      flushPending();
    }

    // Warn for a known tag stranded mid-line — on body lines and inside
    // tag-line values alike (`@ai: note @policy: x` captures the literal
    // `@policy: x` into the value; `@example: desc @widget: y` surfaces it
    // in the example description). Example-block SQL never reaches here:
    // the block collector above absorbs indented/blank lines without
    // warning, since SQL legitimately contains `@…` text.
    const midline = midlineKnownTag(line);
    if (midline !== null) warnMidlineTag(midline);

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
    if (tag === 'expose') {
      // Single-line directive, lifted out of `body` like `@widget`. Accept
      // `rpc` (exposed) and `rpc public` (exposed + public-callable);
      // a later `@expose:` line wins (last-write). Whitespace-normalized so
      // "rpc  public" still parses.
      const tokens = value.toLowerCase().split(/\s+/).filter((t) => t !== '');
      if (tokens.length === 1 && tokens[0] === 'rpc') {
        result.expose = 'rpc';
      } else if (tokens.length === 2 && tokens[0] === 'rpc' && tokens[1] === 'public') {
        result.expose = 'rpc-public';
      } else {
        // Fail closed: an invalid value resets exposure to none so a malformed
        // later line (`@expose: rpc` then `@expose: disabled`) cannot leave an
        // earlier allow active — exposure is a security gate.
        result.expose = 'none';
        console.warn(
          `[@kozou/core] parseCommentTags: invalid @expose value "${value}" ` +
            '(expected "rpc" or "rpc public"; not exposed)',
        );
      }
      continue;
    }
    if (tag === 'arg') {
      const hint = parseArgHint(value);
      if (hint !== null) {
        result.args.push(hint);
      } else {
        console.warn(
          `[@kozou/core] parseCommentTags: invalid @arg value "${value}" ` +
            '(expected "<name> relation(<table.col>)" or "<name> widget(<type>)"; skip)',
        );
      }
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

  result.body = bodyLines.join('\n').trimEnd();
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
