import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

import { PACKAGE_VERSION } from '../src/version.js';

describe('PACKAGE_VERSION', () => {
  it('matches the package.json version and is a semver string', () => {
    const require = createRequire(import.meta.url);
    const pkg = JSON.parse(readFileSync(require.resolve('../package.json'), 'utf8')) as {
      version: string;
    };
    expect(PACKAGE_VERSION).toBe(pkg.version);
    expect(PACKAGE_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
