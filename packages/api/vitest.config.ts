import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // The pure request/query logic (query-builder, schema-lookup,
      // handler) is unit-tested directly; the node:http wiring in
      // startApiServer.ts is exercised end-to-end by the testcontainer
      // integration suite. functions/branches floors sit a few points
      // below current coverage as a regression ratchet (mirrors the
      // gate convention in the other @kozou packages).
      thresholds: {
        lines: 90,
        statements: 90,
        functions: 90,
        branches: 75,
      },
      reporter: ['text', 'lcov'],
    },
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
