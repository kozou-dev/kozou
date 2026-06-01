// Module-scope DataAdapter singleton.
//
// Routes never import a concrete adapter directly; they ask for the
// configured DataAdapter through this getter so the eslint adapter-
// boundary rule (Kozou v0.1 design spec §18.1.1) keeps the backend
// plumbing hidden inside `src/lib/{adapter,server}`.
//
// KOZOU_ADAPTER_KIND selects the backend (Kozou v0.2 Phase 4):
//   - unset / "postgrest" (default): the REST adapter against PostgREST
//   - "api":                         the in-house @kozou/api server
// KOZOU_ADAPTER_URL overrides the base URL for whichever is selected.
// KOZOU_ADAPTER_TOKEN (api backend only): when the @kozou/api server has
// JWT auth enabled, this Bearer token is attached to every request. Under
// `kozou dev --adapter api` the CLI sets it; it is empty otherwise and the
// adapter sends no Authorization header (the unauthenticated default).

import type { DataAdapter } from '@kozou/core';

import { KozouApiDataAdapter, PostgrestDataAdapter } from '$lib/adapter/index.js';

const DEFAULT_POSTGREST_URL = 'http://localhost:3000';
const DEFAULT_API_URL = 'http://localhost:3335';

let cached: DataAdapter | null = null;

export function getAdapter(): DataAdapter {
  if (cached === null) {
    const kind = process.env.KOZOU_ADAPTER_KIND ?? 'postgrest';
    if (kind === 'api') {
      const baseUrl = process.env.KOZOU_ADAPTER_URL ?? DEFAULT_API_URL;
      const token = process.env.KOZOU_ADAPTER_TOKEN;
      const headers =
        token !== undefined && token.length > 0
          ? { Authorization: `Bearer ${token}` }
          : undefined;
      cached = new KozouApiDataAdapter({ baseUrl, headers });
    } else {
      const baseUrl = process.env.KOZOU_ADAPTER_URL ?? DEFAULT_POSTGREST_URL;
      cached = new PostgrestDataAdapter({ baseUrl });
    }
  }
  return cached;
}

/** Test-only hook to reset the singleton between runs. */
export function resetAdapterForTests(): void {
  cached = null;
}
