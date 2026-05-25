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
      exclude: [
        'src/lib/components/ui/**',
        // The server DataAdapter singleton is a thin
        // `getEnv("KOZOU_ADAPTER_URL")` factory consumed by
        // `hooks.server.ts`; isolating it under unit test would
        // mean mocking `$env/static/private`, which the test
        // environment doesn't load. Excluded by Plan 7-H, same
        // policy as kozou's `cli.ts` / `server.ts` in design spec
        // §16.1.1 D.
        'src/lib/server/adapter.ts',
      ],
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
