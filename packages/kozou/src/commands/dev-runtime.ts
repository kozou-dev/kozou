// Pure wiring helpers for `kozou dev` (see commands/dev.ts).
//
// Kept separate from the spawn / lifecycle shell in dev.ts so the
// config -> child-process-env / origin / entry-path mapping can be unit
// tested without launching any servers.

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import type { KozouConfig } from '../config.js';

// Resolve the Admin UI's adapter-node standalone server entry. The
// `build/` directory ships in @kozou/svelte-ui's published `files`, and
// resolving the package's own package.json works whether kozou runs from
// a flat node_modules tree (Docker / npm install) or a workspace symlink
// (local dev).
export function resolveAdminUiEntry(): string {
  const require = createRequire(import.meta.url);
  const pkgJsonPath = require.resolve('@kozou/svelte-ui/package.json');
  return join(dirname(pkgJsonPath), 'build', 'index.js');
}

// The browser-facing origin the Admin UI must accept form posts from.
// An explicit ORIGIN / KOZOU_ORIGIN wins; otherwise default to localhost
// on the UI port (host stays 0.0.0.0 for binding, but browsers reach it
// as localhost in the common single-host case).
export function resolveOrigin(config: KozouConfig, env: NodeJS.ProcessEnv): string {
  return env.ORIGIN ?? env.KOZOU_ORIGIN ?? `http://localhost:${config.server.ui.port}`;
}

// Build the child-process environment for the Admin UI server. Keeping
// it pure makes the wiring unit-testable without spawning anything.
export function buildAdminUiEnv(
  config: KozouConfig,
  origin: string,
  baseEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    DATABASE_URL: config.database.url,
    KOZOU_ADAPTER_URL: config.adapter.url,
    PORT: String(config.server.ui.port),
    HOST: config.server.ui.host,
    ORIGIN: origin,
    NODE_ENV: 'production',
  };
}
