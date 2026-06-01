// Identifier quoting + qualified table names. Shared by the query builder
// and the embed fragment renderer so both quote identifiers identically.

import type { Resource } from './schema-lookup.js';

/** Quote an identifier for safe inlining (defense in depth on top of the
 *  allowlist). */
export function quoteIdent(id: string): string {
  return '"' + id.replace(/"/g, '""') + '"';
}

/** `"schema"."name"` for a resolved resource. */
export function qualified(resource: Resource): string {
  return `${quoteIdent(resource.schema)}.${quoteIdent(resource.name)}`;
}
