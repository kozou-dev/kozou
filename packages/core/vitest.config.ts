import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      thresholds: {
        lines: 90,
        statements: 90,
      },
      reporter: ['text', 'lcov'],
    },
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
