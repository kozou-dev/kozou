import { ZodError } from 'zod';
import type { ColumnContext, SchemaContext } from '@kozou/core';
import { McpToolError } from '../errors.js';
import {
  searchSchemaInputSchema,
  type SearchSchemaHit,
  type SearchSchemaInput,
  type SearchSchemaKind,
  type SearchSchemaMatchedField,
  type SearchSchemaOutput,
} from '../schemas/search_schema.js';

// Selective metadata search over the already-built SchemaContext. This is a
// pure function over the in-memory cache: it reads no rows, runs no new
// introspection, and reaches nothing but the documentation the describe tools
// already expose. It is the connective tissue between `list_*` (enumerate all)
// and `describe_*` (one named object): "which objects relate to X?".
//
// Concepts are deliberately not a hit kind in this first cut. In v0.1 every
// concept is a view (1:1), so a view hit already surfaces the same object and
// name, and `get_concept_context` keys off that same name — a separate concept
// hit would only duplicate the discovery signal. Concept-exclusive text
// (example queries, join meanings) is a natural follow-up.

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const SNIPPET_PAD = 40;

// An identifier/label match is more specific than a prose match; an enum member
// is a fairly specific hit too. Weights are advisory ranking, not a contract.
const FIELD_WEIGHT: Record<SearchSchemaMatchedField, number> = {
  name: 10,
  label: 8,
  enumValue: 7,
  aiDescription: 6,
  description: 5,
  policy: 4,
};

// Long prose fields get a windowed snippet; short fields are returned whole.
const LONG_FIELDS: ReadonlySet<SearchSchemaMatchedField> = new Set<SearchSchemaMatchedField>([
  'description',
  'aiDescription',
  'policy',
]);

// A word char, for the word-boundary bonus (Unicode letters/numbers).
const WORD_CHAR = /[\p{L}\p{N}]/u;

// Escape regex metacharacters so the query matches literally (e.g. "a.b" is a
// dot, not a wildcard).
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface Candidate {
  field: SearchSchemaMatchedField;
  text: string;
}

interface Match {
  field: SearchSchemaMatchedField;
  snippet: string;
  score: number;
}

/** Locate the query (as a precompiled case-insensitive matcher) in `flat` and
 *  score the match quality: whole-field equality > prefix > word-boundary
 *  start > mid-word. The index refers to the ORIGINAL `flat` (matching on a
 *  lower-cased copy would drift for characters whose lowercase changes length,
 *  e.g. U+0130), so the snippet slice and the boundary char stay aligned. */
function findMatch(
  matcher: RegExp,
  queryLower: string,
  flat: string,
): { index: number; length: number; bonus: number } | null {
  const m = matcher.exec(flat);
  if (m === null) return null;
  const index = m.index;
  let bonus = 0;
  if (flat.toLowerCase() === queryLower) bonus = 5;
  else if (index === 0) bonus = 3;
  else if (!WORD_CHAR.test(flat[index - 1] ?? '')) bonus = 1;
  return { index, length: m[0].length, bonus };
}

function makeSnippet(
  field: SearchSchemaMatchedField,
  flat: string,
  index: number,
  matchLen: number,
): string {
  if (!LONG_FIELDS.has(field)) return flat;
  const start = Math.max(0, index - SNIPPET_PAD);
  const end = Math.min(flat.length, index + matchLen + SNIPPET_PAD);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}

/** The single best-scoring field among a node's candidates (one hit per node). */
function bestMatch(matcher: RegExp, queryLower: string, candidates: Candidate[]): Match | null {
  let best: Match | null = null;
  for (const c of candidates) {
    const flat = LONG_FIELDS.has(c.field) ? c.text.replace(/\s+/g, ' ').trim() : c.text.trim();
    if (!flat) continue;
    const found = findMatch(matcher, queryLower, flat);
    if (!found) continue;
    const score = FIELD_WEIGHT[c.field] + found.bonus;
    if (best === null || score > best.score) {
      best = { field: c.field, snippet: makeSnippet(c.field, flat, found.index, found.length), score };
    }
  }
  return best;
}

/** Searchable fields of a column, shared by table and view columns. */
function columnCandidates(col: ColumnContext): Candidate[] {
  const cands: Candidate[] = [
    { field: 'name', text: col.name },
    { field: 'label', text: col.label },
  ];
  if (col.description) cands.push({ field: 'description', text: col.description });
  if (col.aiDescription) cands.push({ field: 'aiDescription', text: col.aiDescription });
  for (const p of col.policy ?? []) cands.push({ field: 'policy', text: p });
  for (const v of col.enumValues ?? []) cands.push({ field: 'enumValue', text: v });
  return cands;
}

export function searchSchema(input: SearchSchemaInput, ctx: SchemaContext): SearchSchemaOutput {
  let parsed: SearchSchemaInput;
  try {
    parsed = searchSchemaInputSchema.parse(input);
  } catch (err) {
    // Turn a validation failure into an actionable, leak-safe message (built
    // only from fixed text) so an agent can self-correct, rather than letting
    // the raw ZodError fall through to the dispatcher's generic "tool failed".
    if (err instanceof ZodError) {
      throw new McpToolError(
        'search_schema: invalid arguments. Requires a non-empty "query" string; ' +
          'optional "schema" (string), "kinds" (a non-empty array of ' +
          'table|column|view|function|enum), and "limit" (a positive integer).',
      );
    }
    throw err;
  }
  const queryLower = parsed.query.toLowerCase();
  // Compile the case-insensitive matcher once per search (not per candidate):
  // the query is fixed, so this bounds the regex cost on large schemas.
  const matcher = new RegExp(escapeRegExp(parsed.query), 'iu');
  const limit = Math.min(parsed.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const kindFilter = parsed.kinds ? new Set<SearchSchemaKind>(parsed.kinds) : null;

  const wantKind = (k: SearchSchemaKind): boolean => kindFilter === null || kindFilter.has(k);
  const inSchema = (s: string): boolean => parsed.schema === undefined || s === parsed.schema;

  const hits: SearchSchemaHit[] = [];
  const push = (
    kind: SearchSchemaKind,
    ref: string,
    label: string,
    candidates: Candidate[],
  ): void => {
    const m = bestMatch(matcher, queryLower, candidates);
    if (m) {
      hits.push({ kind, ref, label, matchedField: m.field, snippet: m.snippet, score: m.score });
    }
  };

  // Tables and their columns.
  if (wantKind('table') || wantKind('column')) {
    for (const t of ctx.tables) {
      if (!inSchema(t.schema)) continue;
      if (wantKind('table')) {
        const cands: Candidate[] = [
          { field: 'name', text: t.name },
          { field: 'label', text: t.label },
        ];
        if (t.description) cands.push({ field: 'description', text: t.description });
        if (t.aiDescription) cands.push({ field: 'aiDescription', text: t.aiDescription });
        for (const p of t.policy ?? []) cands.push({ field: 'policy', text: p });
        push('table', t.qualifiedName, t.label, cands);
      }
      if (wantKind('column')) {
        for (const col of t.columns) {
          push('column', `${t.qualifiedName}.${col.name}`, col.label, columnCandidates(col));
        }
      }
    }
  }

  // Views and their columns. A view's `purpose` is reported under `description`.
  if (wantKind('view') || wantKind('column')) {
    for (const v of ctx.views) {
      if (!inSchema(v.schema)) continue;
      if (wantKind('view')) {
        const cands: Candidate[] = [
          { field: 'name', text: v.name },
          { field: 'label', text: v.label },
        ];
        if (v.description) cands.push({ field: 'description', text: v.description });
        if (v.purpose) cands.push({ field: 'description', text: v.purpose });
        if (v.aiDescription) cands.push({ field: 'aiDescription', text: v.aiDescription });
        for (const p of v.policy ?? []) cands.push({ field: 'policy', text: p });
        push('view', v.qualifiedName, v.label, cands);
      }
      if (wantKind('column')) {
        for (const col of v.columns) {
          push('column', `${v.qualifiedName}.${col.name}`, col.label, columnCandidates(col));
        }
      }
    }
  }

  // Exposed RPC functions.
  if (wantKind('function')) {
    for (const fn of ctx.functions ?? []) {
      if (!inSchema(fn.schema)) continue;
      const cands: Candidate[] = [
        { field: 'name', text: fn.name },
        { field: 'label', text: fn.label },
      ];
      if (fn.description) cands.push({ field: 'description', text: fn.description });
      if (fn.aiDescription) cands.push({ field: 'aiDescription', text: fn.aiDescription });
      for (const p of fn.policy ?? []) cands.push({ field: 'policy', text: p });
      push('function', fn.qualifiedName, fn.label, cands);
    }
  }

  // Enum types (name, description, and members).
  if (wantKind('enum')) {
    for (const e of ctx.enums) {
      if (!inSchema(e.schema)) continue;
      const cands: Candidate[] = [{ field: 'name', text: e.name }];
      if (e.description) cands.push({ field: 'description', text: e.description });
      for (const v of e.values) cands.push({ field: 'enumValue', text: v });
      push('enum', `${e.schema}.${e.name}`, e.name, cands);
    }
  }

  // Rank: score desc, then ref then kind ascending for a stable, deterministic
  // order (two objects can share neither ref nor kind, so this is a total order).
  hits.sort(
    (a, b) =>
      b.score - a.score ||
      (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0) ||
      (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0),
  );

  return {
    query: parsed.query,
    truncated: hits.length > limit,
    hits: hits.slice(0, limit),
  };
}
