import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Tests start a Postgres testcontainer (or reuse KOZOU_TEST_DATABASE_URL
    // in CI). Ground-truth and tool tests load a generated fixture; none of
    // them call a paid API (that is the `bench` script, run manually).
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
