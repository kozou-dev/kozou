// Resolve a request path segment (e.g. "books" or "public.books") to a
// concrete table or view from the introspected SchemaContext. This map is
// the allowlist: only resources that exist in the schema are addressable,
// and only their declared columns can be filtered / sorted on.

import type { SchemaContext, ColumnContext } from '@kozou/core';

export type ResourceKind = 'table' | 'view';

/** A normalized, query-ready view of a table or a view. */
export type Resource = {
  kind: ResourceKind;
  schema: string;
  name: string;
  qualifiedName: string;
  columns: ColumnContext[];
  /** Primary-key columns. Empty for views and PK-less tables. */
  primaryKey: string[];
};

export type ResourceLookup = {
  /** Resolve by bare name (when unambiguous) or by `schema.name`. */
  resolve(name: string): Resource | undefined;
  /** Qualified names of every addressable resource, sorted. */
  list(): string[];
};

export function buildResourceLookup(schema: SchemaContext): ResourceLookup {
  const resources: Resource[] = [];

  for (const t of schema.tables) {
    resources.push({
      kind: 'table',
      schema: t.schema,
      name: t.name,
      qualifiedName: t.qualifiedName,
      columns: t.columns,
      primaryKey: t.primaryKey,
    });
  }
  for (const v of schema.views) {
    resources.push({
      kind: 'view',
      schema: v.schema,
      name: v.name,
      qualifiedName: v.qualifiedName,
      columns: v.columns,
      primaryKey: [],
    });
  }

  const byKey = new Map<string, Resource>();
  const bareNameCounts = new Map<string, number>();
  for (const r of resources) {
    byKey.set(r.qualifiedName, r);
    bareNameCounts.set(r.name, (bareNameCounts.get(r.name) ?? 0) + 1);
  }
  // Register the bare name only when it is unique across schemas and does
  // not collide with an existing qualified-name key.
  for (const r of resources) {
    if (bareNameCounts.get(r.name) === 1 && !byKey.has(r.name)) {
      byKey.set(r.name, r);
    }
  }

  const sortedNames = resources.map((r) => r.qualifiedName).sort();

  return {
    resolve: (name) => byKey.get(name),
    list: () => sortedNames,
  };
}
