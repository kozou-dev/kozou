import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
  test: {
    environment: 'jsdom',
    include: ['test/**/*.{test,spec}.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/lib/**/*.ts'],
      // `src/lib/server/adapter.ts` used to be excluded here; it is now
      // unit-tested (test/server/adapter.test.ts) by mocking the adapter
      // class and driving `KOZOU_ADAPTER_URL` via `process.env`.
      exclude: ['src/lib/components/ui/**'],
      reporter: ['text', 'lcov'],
      // Enforce DoD #6 from Step 6. Branches/functions stay
      // unmetered for v0.1; design spec §16.1.1 B reactivates the
      // tighter gates in v0.1.1 along with the other deferred
      // items.
      thresholds: {
        lines: 90,
      },
    },
  },
});
