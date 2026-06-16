import { describe, expect, it } from 'vitest';

import { quoteLikeValue } from '../../src/adapter/search-quote.js';

describe('quoteLikeValue', () => {
  it('wraps a plain term in double-quoted substring wildcards', () => {
    expect(quoteLikeValue('svelte')).toBe('"*svelte*"');
  });

  it('keeps reserved characters inside the quoted value', () => {
    // `,` `(` `)` `.` `:` would otherwise be read as or()-tree structure.
    expect(quoteLikeValue('Smith, John')).toBe('"*Smith, John*"');
    expect(quoteLikeValue('a(b).c:d')).toBe('"*a(b).c:d*"');
  });

  it('backslash-escapes embedded double quotes and backslashes', () => {
    expect(quoteLikeValue('say "hi"')).toBe('"*say \\"hi\\"*"');
    expect(quoteLikeValue('a\\b')).toBe('"*a\\\\b*"');
    // Backslash is escaped before the quote so the order cannot double-escape.
    expect(quoteLikeValue('\\"')).toBe('"*\\\\\\"*"');
  });

  it('leaves wildcard metacharacters untouched (substring contract is unchanged)', () => {
    // `*` `%` `_` keep their ilike meaning — quoting only protects structure.
    expect(quoteLikeValue('a*b%c_d')).toBe('"*a*b%c_d*"');
  });

  it('handles the empty term', () => {
    expect(quoteLikeValue('')).toBe('"**"');
  });
});
