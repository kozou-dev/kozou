// Opaque, URL-safe cursor for keyset pagination (issue #185).
//
// A cursor encodes (a) the effective ORDER BY signature — each column and its
// direction, in order — and (b) the boundary row's values for those columns.
// The signature lets the server reject a cursor whose ordering does not match
// the current request (e.g. the client changed `sort`) with a 400, rather than
// silently returning wrong rows; the values seed the keyset predicate. The
// payload is `base64url(JSON)` — opaque to clients and NOT a stable format to
// depend on.

import { badRequest } from './errors.js';

export type CursorOrderKey = { field: string; order: 'asc' | 'desc' };

export type DecodedCursor = {
  /** The ORDER BY signature this cursor was issued for (forward order). */
  order: CursorOrderKey[];
  /** Boundary-row values, positionally aligned with `order`. */
  values: unknown[];
};

/** Encode a cursor from the effective forward order and a boundary row's values
 *  for those columns. */
export function encodeCursor(order: CursorOrderKey[], values: unknown[]): string {
  const payload = { o: order.map((k) => [k.field, k.order]), v: values };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/** Decode and shape-validate a cursor string. Any malformation is a 400 (client
 *  input), never a 500. Does not validate against the request's order — that is
 *  the query builder's job, which knows the resource's effective order. */
export function decodeCursor(raw: string): DecodedCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw badRequest('Malformed pagination cursor.');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw badRequest('Malformed pagination cursor.');
  }
  const { o, v } = parsed as { o?: unknown; v?: unknown };
  if (!Array.isArray(o) || !Array.isArray(v) || o.length === 0 || o.length !== v.length) {
    throw badRequest('Malformed pagination cursor.');
  }
  const order: CursorOrderKey[] = o.map((entry) => {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== 'string' ||
      (entry[1] !== 'asc' && entry[1] !== 'desc')
    ) {
      throw badRequest('Malformed pagination cursor.');
    }
    return { field: entry[0], order: entry[1] };
  });
  // A genuine cursor only ever carries the column's PostgreSQL text form (or
  // null) — see the `::text` cursor key projection. Enforce that here so a
  // forged value of another JSON type (an array/object/number) cannot slip past
  // the type pre-flight via `String(value)` and then bind a non-scalar into the
  // keyset predicate (which PostgreSQL would reject as a 500).
  const values = v as unknown[];
  for (const value of values) {
    if (value !== null && typeof value !== 'string') {
      throw badRequest('Malformed pagination cursor.');
    }
  }
  return { order, values };
}
