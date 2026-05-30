import { describe, expect, it } from 'vitest';

import { version } from '../package.json';
import { PACKAGE_VERSION } from '../src/lib/index.js';

describe('@kozou/svelte-ui sanity', () => {
  it('exposes the package version sourced from package.json', () => {
    expect(typeof PACKAGE_VERSION).toBe('string');
    // Asserts against package.json directly rather than a hardcoded
    // literal, so the test cannot go stale across a version bump.
    expect(PACKAGE_VERSION).toBe(version);
  });
});
