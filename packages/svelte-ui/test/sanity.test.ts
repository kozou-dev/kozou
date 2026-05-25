import { describe, expect, it } from 'vitest';

import { PACKAGE_VERSION } from '../src/lib/index.js';

describe('@kozou/svelte-ui sanity', () => {
  it('exposes a string package version constant', () => {
    expect(typeof PACKAGE_VERSION).toBe('string');
    expect(PACKAGE_VERSION).toBe('0.0.0');
  });
});
