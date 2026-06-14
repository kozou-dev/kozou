// Identifier quoting for safe inlining of schema / table / column / role names
// into SQL text — defense in depth on top of the exposed-surface allowlist.
// Shared so every layer (query builder, RPC call builder, the role-transaction
// envelope) quotes identifiers identically.

/** Quote an identifier for safe inlining into SQL. */
export function quoteIdent(id: string): string {
  return '"' + id.replace(/"/g, '""') + '"';
}
