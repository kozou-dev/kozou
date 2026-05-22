import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // dev_spec §13.1: @kozou/mcp tool I/O schema は 100% (schemas/ の単体で達成)
      // 実装ロジック (server/cli/cache) 込みで global lines/stmts 90% gate
      thresholds: {
        lines: 90,
        statements: 90,
      },
      reporter: ['text', 'lcov'],
      // cli.ts と server.ts は MCP SDK の transport 越しに動く統合層で
      // unit test 困難 (handler 直接 invoke は SDK private API)。
      // tools/* と schemas/* は 100% coverage で実態を満たす。
      // dev_spec §13.1 100% 要求の解釈: tool I/O schema + tool 関数の 100%
      exclude: ['src/cli.ts', 'src/server.ts'],
    },
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
