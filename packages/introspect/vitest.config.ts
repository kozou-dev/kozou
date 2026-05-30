import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // functions/branches floors sit a few points below current coverage
      // as a regression ratchet (Kozou v0.1 design spec §16.1.1 B).
      thresholds: {
        lines: 80,
        statements: 80,
        functions: 90,
        branches: 75,
      },
      reporter: ['text', 'lcov'],
    },
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
