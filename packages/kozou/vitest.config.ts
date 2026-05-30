import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Unit/integration tests live under test/. The Playwright suite under
    // e2e/ is driven by `pnpm test:e2e`, not vitest — scope the include so
    // `vitest run` does not try to execute the *.spec.ts e2e files.
    include: ['test/**/*.{test,spec}.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // functions/branches floors sit a few points below current coverage
      // as a regression ratchet (Kozou v0.1 design spec §16.1.1 B).
      thresholds: {
        lines: 90,
        statements: 90,
        functions: 95,
        branches: 78,
      },
      reporter: ['text', 'lcov'],
      // cli.ts, create-kozou.ts, commands/mcp.ts, commands/dev.ts are
      // process-exit / I/O / MCP-SDK integration shells driven by the
      // bin entries; they are exercised through manual smoke tests
      // rather than unit tests. The logic they orchestrate lives in
      // config.ts / scaffold.ts / commands/inspect.ts where it is
      // covered.
      exclude: [
        'src/cli.ts',
        'src/create-kozou.ts',
        'src/commands/mcp.ts',
        'src/commands/dev.ts',
        'src/index.ts',
      ],
    },
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
