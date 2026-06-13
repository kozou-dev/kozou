// Composite-aware helpers for the `[id]` route segment.
//
// A single-column primary key is carried verbatim in the URL; a composite
// key joins its components — in `primaryKey` declaration order — into one
// path segment, each component percent-encoded and separated by an
// unescaped comma. The route stays a
// single dynamic `[id]` param; only the value shape changes, so the
// SvelteKit routing table is untouched.
//
// Limitation: a composite key value cannot itself contain a comma. The
// SvelteKit param (and the in-house API handler) URL-decode the whole
// segment before splitting on commas, so an encoded `%2C` is
// indistinguishable from a separator. Single-column keys are unaffected.
// This matches the server's documented limit.

import type { ResourceId } from '@kozou/core';

/**
 * Build the `[id]` path segment for a row from its primary-key columns.
 * Returns `null` when the key is empty or any key column is missing/null on
 * the row, so callers can fall back (e.g. to the row index for a keyed
 * `{#each}`). A single-column key yields a plain encoded value; a composite
 * key yields the comma-joined form.
 */
export function rowIdSegment(
  row: Record<string, unknown>,
  primaryKey: string[],
): string | null {
  if (primaryKey.length === 0) return null;
  const parts: string[] = [];
  for (const column of primaryKey) {
    const value = row[column];
    if (value === undefined || value === null) return null;
    parts.push(encodeURIComponent(String(value)));
  }
  return parts.join(',');
}

/**
 * Encode a {@link ResourceId} back into the `[id]` path segment. The inverse
 * of {@link parseResourceId}, used to build canonical detail / edit links
 * and redirects from already-resolved key values.
 */
export function encodeResourceId(id: ResourceId): string {
  if (Array.isArray(id)) {
    return id.map((part) => encodeURIComponent(String(part))).join(',');
  }
  return encodeURIComponent(String(id));
}

/**
 * Parse the (SvelteKit-decoded) `[id]` route param into a {@link ResourceId}
 * for the DataAdapter. A single-column key passes through verbatim (the value
 * may contain a comma); a composite key splits on commas — the components are
 * already URL-decoded by SvelteKit. The component count is not validated here;
 * the adapter / server reports an arity mismatch.
 */
export function parseResourceId(
  idParam: string,
  primaryKey: string[],
): ResourceId {
  if (primaryKey.length > 1) {
    return idParam.split(',');
  }
  return idParam;
}
