import type { RawCheck } from './types/raw.js';

// A CHECK constraint expression is library input (it comes from introspecting
// the database via pg_get_constraintdef). Running a backtracking regex on it
// is a polynomial-ReDoS shape that CodeQL flags (js/polynomial-redos): an
// unanchored match with a greedy negated class and no terminator is O(n²) on a
// crafted string. So the two enum shapes below are located by a single linear
// scan (indexOf + one-directional walks), never a regex on the expression —
// the same avoidance the COMMENT parser uses (see parseCommentTags). Only the
// quoted-value extraction keeps a regex, and it runs on the already-isolated,
// bounded value list.

const QUOTED_VALUE_RE = /'((?:[^']|'')*)'/g;

function extractQuotedValues(input: string): string[] {
  const out: string[] = [];
  for (const match of input.matchAll(QUOTED_VALUE_RE)) {
    out.push(match[1]!.replace(/''/g, "'"));
  }
  return out;
}

function isWordChar(c: string): boolean {
  return (
    (c >= 'a' && c <= 'z') ||
    (c >= 'A' && c <= 'Z') ||
    (c >= '0' && c <= '9') ||
    c === '_'
  );
}

function isWs(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v';
}

/** The column identifier immediately to the left of `before` (exclusive),
 *  across the shapes a CHECK constraint uses for the column reference:
 *  `foo`, `"foo"`, `(foo)`, `(foo)::text`, `foo::text`, `t.foo`. Returns the
 *  bare identifier (matching the original regex's `(\w+)` capture), or null
 *  when none is there. A single left-walk — no regex. */
function columnBefore(expr: string, before: number): string | null {
  let i = before - 1;
  while (i >= 0 && isWs(expr[i]!)) i--;
  // optional single-word `::cast` (e.g. `::text`), matching `(?:::\w+)?`
  if (i >= 0 && isWordChar(expr[i]!)) {
    let j = i;
    while (j >= 0 && isWordChar(expr[j]!)) j--;
    if (j - 1 >= 0 && expr[j] === ':' && expr[j - 1] === ':') {
      i = j - 2;
      while (i >= 0 && isWs(expr[i]!)) i--;
    }
  }
  if (i >= 0 && expr[i] === ')') {
    i--;
    while (i >= 0 && isWs(expr[i]!)) i--;
  }
  if (i >= 0 && (expr[i] === '"' || expr[i] === "'")) i--;
  const end = i;
  while (i >= 0 && isWordChar(expr[i]!)) i--;
  if (i + 1 > end) return null;
  return expr.slice(i + 1, end + 1);
}

type ParsedEnum = { column: string; valueList: string };

/** `<colref> = ANY (ARRAY[ <values> ])` — the form pg_get_constraintdef
 *  normalises `col IN (...)` into on PostgreSQL 16. */
function parseAnyArray(expr: string, lower: string): ParsedEnum | null {
  let pos = 0;
  for (;;) {
    const any = lower.indexOf('any', pos);
    if (any === -1) return null;
    pos = any + 3;
    // `any` must be a standalone keyword.
    if (any > 0 && isWordChar(expr[any - 1]!)) continue;
    if (isWordChar(expr[any + 3] ?? '')) continue;
    // Left of `any`: optional whitespace then `=`.
    let i = any - 1;
    while (i >= 0 && isWs(expr[i]!)) i--;
    if (i < 0 || expr[i] !== '=') continue;
    const eq = i;
    // Right of `any`: `( ARRAY [` (whitespace-tolerant), then the value list up
    // to the matching `]` (first `]`, like the original `[^\]]+`).
    let k = any + 3;
    while (k < expr.length && isWs(expr[k]!)) k++;
    if (expr[k] !== '(') continue;
    k++;
    while (k < expr.length && isWs(expr[k]!)) k++;
    if (lower.slice(k, k + 5) !== 'array') continue;
    k += 5;
    while (k < expr.length && isWs(expr[k]!)) k++;
    if (expr[k] !== '[') continue;
    const open = k;
    const close = expr.indexOf(']', open + 1);
    if (close === -1) continue;
    const column = columnBefore(expr, eq);
    if (column) return { column, valueList: expr.slice(open + 1, close) };
  }
}

/** `<colref> IN ( <values> )` — a hand-written CHECK. */
function parseInList(expr: string, lower: string): ParsedEnum | null {
  let pos = 0;
  for (;;) {
    const inIdx = lower.indexOf('in', pos);
    if (inIdx === -1) return null;
    pos = inIdx + 2;
    // `in` must be a standalone keyword (not part of `min`, `join`, `within`…).
    if (inIdx > 0 && isWordChar(expr[inIdx - 1]!)) continue;
    if (isWordChar(expr[inIdx + 2] ?? '')) continue;
    // Right of `in`: optional whitespace then `(`, then the value list up to the
    // matching `)` (first `)`, like the original `[^)]+`).
    let k = inIdx + 2;
    while (k < expr.length && isWs(expr[k]!)) k++;
    if (expr[k] !== '(') continue;
    const open = k;
    const close = expr.indexOf(')', open + 1);
    if (close === -1) continue;
    const column = columnBefore(expr, inIdx);
    if (column) return { column, valueList: expr.slice(open + 1, close) };
  }
}

/** Locate the enum shape in a CHECK expression. The `= ANY (ARRAY[…])` form is
 *  preferred over `IN (…)` (matching the original `anyMatch ?? inMatch`). */
function parseEnumCheck(expr: string): ParsedEnum | null {
  const lower = expr.toLowerCase();
  return parseAnyArray(expr, lower) ?? parseInList(expr, lower);
}

export function extractCheckEnums(checks: RawCheck[]): Map<string, string[]> {
  const result = new Map<string, string[]>();

  for (const check of checks) {
    const expr = check.expression;
    const parsed = parseEnumCheck(expr);
    if (!parsed) {
      continue;
    }
    const column = parsed.column;
    const values = extractQuotedValues(parsed.valueList);
    if (values.length === 0) {
      console.warn(
        `[@kozou/core] extractCheckEnums: failed to extract values from check "${check.name}" (expression: ${expr})`,
      );
      continue;
    }

    if (result.has(column)) {
      console.warn(
        `[@kozou/core] extractCheckEnums: column "${column}" has multiple enum CHECK constraints (last one wins)`,
      );
    }
    result.set(column, values);
  }

  return result;
}
