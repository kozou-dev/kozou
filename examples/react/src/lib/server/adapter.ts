// Server-side DataAdapter singleton. The spike talks to the in-house
// @kozou/api server through @kozou/ui-core's KozouApiDataAdapter, which
// resolves primary keys server-side and therefore needs no SchemaContext.
// KOZOU_ADAPTER_URL overrides the base URL; KOZOU_ADAPTER_TOKEN, when the
// API has JWT auth enabled, is attached as a Bearer token.

import type { DataAdapter } from '@kozou/core';
import { KozouApiDataAdapter } from '@kozou/ui-core';

const DEFAULT_API_URL = 'http://localhost:3335';

let cached: DataAdapter | null = null;

export function getAdapter(): DataAdapter {
  if (cached !== null) return cached;

  const baseUrl = process.env.KOZOU_ADAPTER_URL ?? DEFAULT_API_URL;
  const token = process.env.KOZOU_ADAPTER_TOKEN;
  const headers =
    token !== undefined && token.length > 0
      ? { Authorization: `Bearer ${token}` }
      : undefined;

  cached = new KozouApiDataAdapter({ baseUrl, headers });
  return cached;
}
