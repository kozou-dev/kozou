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
