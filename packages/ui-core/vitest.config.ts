import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Thresholds act as a regression ratchet: they sit a little below
      // the current measured coverage of the extracted read-path modules.
      thresholds: {
        lines: 90,
        statements: 90,
        functions: 90,
        branches: 80,
      },
      reporter: ['text', 'lcov'],
    },
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
