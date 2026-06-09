// Resolve foreign-key columns on a detail row to the referenced
// row's displayField label.
//
// Pure function (modulo the injected `loadRow`) so the unit test can
// drive every branch without spinning up a DataAdapter. The detail
// route loader wires `loadRow` to a FkRowCache-backed call into the
// real DataAdapter. Tracks Kozou v0.1 design spec §16.1.1 B (FK
// label resolution).
//
// Behaviour:
// - Skip FK columns whose row value is `null` / `undefined`.
// - Look up the referenced table inside the SchemaContext. If it is
//   absent (orphaned FK, schema drift) emit an entry with `label: null`
//   so the template can fall back to the raw value.
// - If the referenced table has no `displayField` heuristic
//   (Kozou v0.1 spec §6.5), or the loaded row does not carry that
//   field, emit `label: null` similarly.
// - Issue every lookup in parallel via `Promise.all`. The cache layer
//   is responsible for dedupe of repeat keys within a render.

import type { SchemaContext, TableContext } from '@kozou/core';

import type { FkRowLoader } from '$lib/server/fk-row-cache.js';

export interface ResolvedFkLabel {
  /** Raw FK value as stored on the source row (typically a UUID
   *  string but can be a numeric surrogate key). */
  value: string | number;
  /** Label projected from `referencedTable.displayField`, or `null`
   *  when the target row / displayField is missing. */
  label: string | null;
  /** `schema.table` of the referenced row, kept on the result so the
   *  template can build a future link without re-deriving it. */
  referencedQualifiedName: string;
}

export interface ResolveFkLabelsArgs {
  table: TableContext;
  row: Record<string, unknown>;
  schema: SchemaContext;
  loadRow: FkRowLoader;
}

export async function resolveFkLabels(
  args: ResolveFkLabelsArgs,
): Promise<Record<string, ResolvedFkLabel>> {
  const { table, row, schema, loadRow } = args;
  const out: Record<string, ResolvedFkLabel> = {};
  const lookups: Promise<void>[] = [];

  for (const relation of table.relations) {
    // Composite (multi-column) foreign keys cannot be resolved by a single
    // column value; their label resolution is deferred (the raw values render
    // as-is). Single-column relations resolve as before.
    if ((relation.fields ?? [relation.field]).length > 1) continue;
    const rawValue = row[relation.field];
    if (rawValue === null || rawValue === undefined) continue;
    if (typeof rawValue !== 'string' && typeof rawValue !== 'number') continue;
    const value: string | number = rawValue;

    const referencedQualifiedName = `${relation.references.schema}.${relation.references.table}`;
    const referencedTable = schema.tables.find(
      (t) => t.qualifiedName === referencedQualifiedName,
    );
    if (referencedTable === undefined) {
      out[relation.field] = { value, label: null, referencedQualifiedName };
      continue;
    }

    lookups.push(
      loadRow(referencedQualifiedName, value).then((targetRow) => {
        const label = projectLabel(referencedTable, targetRow);
        out[relation.field] = { value, label, referencedQualifiedName };
      }),
    );
  }

  await Promise.all(lookups);
  return out;
}

function projectLabel(
  referencedTable: TableContext,
  targetRow: Record<string, unknown> | null,
): string | null {
  if (targetRow === null) return null;
  const display = referencedTable.displayField;
  if (display === null) return null;
  const value = targetRow[display];
  if (value === null || value === undefined) return null;
  return String(value);
}
