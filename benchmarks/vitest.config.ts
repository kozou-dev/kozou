import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Tests start a Postgres testcontainer (or reuse KOZOU_TEST_DATABASE_URL
    // in CI) and, for the A2 arm, an in-process MCP HTTP server.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
