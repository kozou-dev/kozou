import { describe, it, expect } from 'vitest';
import { encodeCursor, decodeCursor } from '../src/cursor.js';
import { KozouApiError } from '../src/errors.js';

// base64url of a raw JSON payload, to forge specific malformed cursors.
const raw = (json: string): string => Buffer.from(json, 'utf8').toString('base64url');

describe('cursor codec (#185)', () => {
  it('round-trips the order signature and the (text) boundary values', () => {
    const order = [
      { field: 'created_at', order: 'desc' as const },
      { field: 'id', order: 'asc' as const },
    ];
    // Boundary values are always the column's PostgreSQL text form (or null).
    const values = ['2020-01-01 00:00:00', '42'];
    const decoded = decodeCursor(encodeCursor(order, values));
    expect(decoded.order).toEqual(order);
    expect(decoded.values).toEqual(values);
  });

  it('preserves a null boundary value (nullable sort column)', () => {
    const decoded = decodeCursor(
      encodeCursor(
        [
          { field: 'score', order: 'asc' },
          { field: 'id', order: 'asc' },
        ],
        [null, '7'],
      ),
    );
    expect(decoded.values).toEqual([null, '7']);
  });

  it('is URL-safe (base64url: no +, /, or =)', () => {
    const s = encodeCursor([{ field: 'id', order: 'asc' }], [1]);
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('rejects every malformed cursor with a 400, never a 500', () => {
    const bad = [
      'this is not base64url JSON @#$',
      raw('not json'),
      raw('[]'), // not an {o,v} object
      raw('{"o":[],"v":[]}'), // empty order
      raw('{"o":[["id","asc"]],"v":["a","b"]}'), // length mismatch (1 vs 2)
      raw('{"o":[["id","sideways"]],"v":["a"]}'), // bad direction
      raw('{"o":[[42,"asc"]],"v":["a"]}'), // non-string field
      // Forged non-string boundary values: must be rejected so they cannot pass
      // the type pre-flight via String(value) and bind a non-scalar.
      raw('{"o":[["id","asc"]],"v":[["a"]]}'), // array value
      raw('{"o":[["id","asc"]],"v":[5]}'), // number value
      raw('{"o":[["id","asc"]],"v":[{"x":1}]}'), // object value
    ];
    for (const cursor of bad) {
      expect(() => decodeCursor(cursor), cursor).toThrow(KozouApiError);
      try {
        decodeCursor(cursor);
      } catch (err) {
        expect((err as KozouApiError).status, cursor).toBe(400);
      }
    }
  });
});
