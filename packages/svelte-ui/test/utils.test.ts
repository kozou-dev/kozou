// Trivial smoke for the `cn(...)` class-name helper in
// `src/lib/utils.ts`. The function is a one-line `twMerge(clsx(...))`
// composition; this test exists so the file does not sit at 0
// coverage and drag the workspace under the 90% line threshold.

import { describe, it, expect } from 'vitest';

import { cn } from '../src/lib/utils';

describe('cn', () => {
  it('concatenates truthy class fragments', () => {
    expect(cn('foo', 'bar')).toBe('foo bar');
  });

  it('drops falsy fragments before delegating to tailwind-merge', () => {
    expect(cn('foo', false && 'bar', null, undefined, 'baz')).toBe('foo baz');
  });

  it('lets tailwind-merge collapse conflicting utilities', () => {
    // tailwind-merge keeps the rightmost utility when two rules
    // target the same property; this guards against accidentally
    // swapping the composition order in the future.
    expect(cn('p-2', 'p-4')).toBe('p-4');
  });
});
