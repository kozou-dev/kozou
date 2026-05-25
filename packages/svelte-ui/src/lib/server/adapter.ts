// Module-scope DataAdapter singleton.
//
// Routes never import PostgrestDataAdapter directly; they ask for
// the configured DataAdapter through this getter so the eslint
// adapter-boundary rule (Kozou v0.1 design spec §18.1.1) keeps
// the PostgREST plumbing hidden inside `src/lib/{adapter,server}`.

import type { DataAdapter } from '@kozou/core';

import { PostgrestDataAdapter } from '$lib/adapter/index.js';

const DEFAULT_ADAPTER_URL = 'http://localhost:3000';

let cached: DataAdapter | null = null;

export function getAdapter(): DataAdapter {
  if (cached === null) {
    const baseUrl = process.env.KOZOU_ADAPTER_URL ?? DEFAULT_ADAPTER_URL;
    cached = new PostgrestDataAdapter({ baseUrl });
  }
  return cached;
}

/** Test-only hook to reset the singleton between runs. */
export function resetAdapterForTests(): void {
  cached = null;
}
