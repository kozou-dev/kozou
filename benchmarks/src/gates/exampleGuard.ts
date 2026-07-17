// C-2 example-readback guard.
//
// The Kozou arm surfaces @example / recommended-query text from comments. If a
// comment's example reproduced a task's canonical_sql, arm C would be handed
// the answer verbatim — the worst form of the "author writes the answer into
// the fixture, then measures it" circularity. This guard mechanically checks
// that no comment (and specifically no SQL-looking fragment in a comment)
// reproduces any canonical_sql, using character-trigram Jaccard similarity.
//
// Operates on RESOLVED text (mangled names) so it compares like-for-like with
// the resolved canonical_sql.

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

function trigrams(text: string): Set<string> {
  const n = normalize(text);
  const set = new Set<string>();
  for (let i = 0; i + 3 <= n.length; i += 1) set.add(n.slice(i, i + 3));
  return set;
}

export function jaccard(a: string, b: string): number {
  const ta = trigrams(a);
  const tb = trigrams(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const g of ta) if (tb.has(g)) inter += 1;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Extract the body of every `COMMENT ON ... IS '...';` in the SQL.
 *  Hand-written single-pass scanner (no backtracking regex) that reads the
 *  quoted literal with '' escapes — avoids any polynomial-ReDoS surface. */
export function extractComments(sql: string): string[] {
  const out: string[] = [];
  const marker = ' IS ';
  const upper = sql.toUpperCase();
  let searchFrom = 0;
  for (;;) {
    const head = upper.indexOf('COMMENT ON', searchFrom);
    if (head < 0) break;
    const isIdx = upper.indexOf(marker, head);
    if (isIdx < 0) break;
    // Advance to the opening quote after "IS".
    let i = isIdx + marker.length;
    while (i < sql.length && sql[i] !== "'") i += 1;
    if (i >= sql.length) break;
    i += 1; // past opening quote
    let body = '';
    for (; i < sql.length; i += 1) {
      if (sql[i] === "'") {
        if (sql[i + 1] === "'") {
          body += "'";
          i += 1; // consume the escaped quote pair
        } else {
          break; // closing quote
        }
      } else {
        body += sql[i];
      }
    }
    out.push(body);
    searchFrom = i + 1;
  }
  return out;
}

/** Candidate SQL fragments inside a comment: from the first SELECT to the end,
 *  plus the whole comment as a fallback. */
function candidateFragments(comment: string): string[] {
  const frags = [comment];
  const idx = comment.toLowerCase().indexOf('select');
  if (idx >= 0) frags.push(comment.slice(idx));
  return frags;
}

export interface GuardViolation {
  comment: string;
  fragment: string;
  canonicalSql: string;
  similarity: number;
}

export interface GuardResult {
  ok: boolean;
  threshold: number;
  maxSimilarity: number;
  violations: GuardViolation[];
}

/**
 * Fail if any comment fragment is >= `threshold` similar to any canonical_sql.
 * `canonicalSqls` must be the RESOLVED SQL (mangled names).
 */
export function checkExampleGuard(
  schemaSql: string,
  canonicalSqls: string[],
  threshold = 0.5,
): GuardResult {
  const comments = extractComments(schemaSql);
  const violations: GuardViolation[] = [];
  let maxSimilarity = 0;

  for (const comment of comments) {
    for (const fragment of candidateFragments(comment)) {
      for (const q of canonicalSqls) {
        const sim = jaccard(fragment, q);
        if (sim > maxSimilarity) maxSimilarity = sim;
        if (sim >= threshold) {
          violations.push({ comment, fragment, canonicalSql: q, similarity: sim });
        }
      }
    }
  }

  return { ok: violations.length === 0, threshold, maxSimilarity, violations };
}
