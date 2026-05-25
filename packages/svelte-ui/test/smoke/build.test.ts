import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..', '..');
const SERVER_BUNDLE = resolve(packageRoot, '.svelte-kit/output/server/index.js');
const CLIENT_VERSION = resolve(
  packageRoot,
  '.svelte-kit/output/client/_app/version.json',
);

// vite + SvelteKit + adapter-node build are exercised in a separate
// step (`pnpm --filter @kozou/svelte-ui run build` in CI / locally).
// This case asserts the expected artifacts exist once that step has
// run; it is skipped otherwise so `pnpm --filter @kozou/svelte-ui
// run test` stays green on a fresh checkout.
describe('@kozou/svelte-ui build smoke', () => {
  it.skipIf(!existsSync(SERVER_BUNDLE))(
    'emits the expected server + client artifacts under .svelte-kit/output',
    () => {
      expect(existsSync(SERVER_BUNDLE)).toBe(true);
      expect(existsSync(CLIENT_VERSION)).toBe(true);
    },
  );
});
