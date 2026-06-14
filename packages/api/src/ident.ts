// Qualified table names for the query builder and the embed fragment renderer.
// The identifier-quoting primitive itself lives in @kozou/core (shared with the
// role-transaction envelope and the MCP execution surface); it is re-exported
// here so existing call sites keep importing it from this module.

import type { Resource } from './schema-lookup.js';
import { quoteIdent } from '@kozou/core';

export { quoteIdent };

/** `"schema"."name"` for a resolved resource. */
export function qualified(resource: Resource): string {
  return `${quoteIdent(resource.schema)}.${quoteIdent(resource.name)}`;
}
