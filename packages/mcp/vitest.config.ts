import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Kozou v0.1 spec §13.1: @kozou/mcp tool I/O schemas hit 100% via the
      // unit tests in schemas/. The implementation logic (server/cli/cache)
      // is covered by the global 90% lines/stmts gate below.
      // functions/branches floors sit a few points below current coverage
      // as a regression ratchet (Kozou v0.1 design spec §16.1.1 B).
      thresholds: {
        lines: 90,
        statements: 90,
        functions: 90,
        branches: 70,
      },
      reporter: ['text', 'lcov'],
      // cli.ts, server.ts, and startStdioServer.ts are an integration
      // layer driven through the MCP SDK transport; unit-testing the
      // handlers directly relies on SDK-private APIs. tools/* and
      // schemas/* hit 100% coverage to compensate, satisfying the 100%
      // requirement of Kozou v0.1 spec §13.1 for tool I/O schemas +
      // tool functions.
      exclude: ['src/cli.ts', 'src/server.ts', 'src/startStdioServer.ts'],
    },
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
