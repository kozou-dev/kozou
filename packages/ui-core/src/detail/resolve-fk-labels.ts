// Resolve foreign-key columns on a detail row to the referenced
// row's displayField label.
//
// Pure function (modulo the injected `loadRow`) so the unit test can
// drive every branch without spinning up a DataAdapter. The detail
// route loader wires `loadRow` to a FkRowCache-backed call into the
// real DataAdapter. Tracks FK label resolution.
//
// Behaviour:
// - Skip FK columns whose row value is `null` / `undefined`.
// - Look up the referenced table inside the SchemaContext. If it is
//   absent (orphaned FK, schema drift) emit an entry with `label: null`
//   so the template can fall back to the raw value.
// - If the referenced table has no `displayField` heuristic, or the
//   loaded row does not carry that field, emit `label: null` similarly.
// - A composite (multi-column) relation resolves through the target's
//   primary key: its entry is keyed by the relation's first column and
//   carries the encoded composite id as `value` (the detail-link
//   segment). It is skipped — raw values render as-is — when the
//   relation does not cover the target's full primary key (the row
//   cannot be addressed by id then), when any component is missing,
//   or when another relation claims the same first column (resolving
//   both would race on the shared key).
// - Issue every lookup in parallel via `Promise.all`. The cache layer
//   is responsible for dedupe of repeat keys within a render.

import type { RelationContext, SchemaContext, TableContext } from '@kozou/core';

import { encodeResourceId } from '../resource-id.js';
import type { FkRowLoader } from '../server/fk-row-cache.js';

export interface ResolvedFkLabel {
  /** Raw FK value as stored on the source row (typically a UUID
   *  string but can be a numeric surrogate key). For a composite
   *  relation, the encoded id segment (each component
   *  percent-encoded, comma-joined) — ready for the detail link. */
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

  // Resolved labels are keyed by column name. Two relations can claim the
  // same column — e.g. composite keys sharing a leading tenant_id, or a
  // column that is both a single FK and a composite component — and the
  // parallel lookups would then overwrite each other nondeterministically.
  // A composite relation therefore only resolves when its first column is
  // claimed by no other relation; the single-column behaviour is unchanged.
  const claims = new Map<string, number>();
  for (const relation of table.relations) {
    const first = (relation.fields ?? [relation.field])[0];
    claims.set(first, (claims.get(first) ?? 0) + 1);
  }

  for (const relation of table.relations) {
    const fields = relation.fields ?? [relation.field];
    if (fields.length > 1) {
      if ((claims.get(fields[0]) ?? 0) > 1) continue;
      const lookup = compositeLookup(fields, relation, row, schema, loadRow, out);
      if (lookup !== null) lookups.push(lookup);
      continue;
    }
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

/** Build the lookup for a composite relation, or return `null` when it
 *  cannot be resolved (the raw values then render as-is). The target row is
 *  fetched by primary key, so the relation must reference the target's full
 *  primary key (in any column order) and every component must be present.
 *  The resolved entry is keyed by the relation's first column. */
function compositeLookup(
  fields: string[],
  relation: RelationContext,
  row: Record<string, unknown>,
  schema: SchemaContext,
  loadRow: FkRowLoader,
  out: Record<string, ResolvedFkLabel>,
): Promise<void> | null {
  const referencedQualifiedName = `${relation.references.schema}.${relation.references.table}`;
  const referencedTable = schema.tables.find(
    (t) => t.qualifiedName === referencedQualifiedName,
  );
  if (referencedTable === undefined) return null;

  const refColumns = relation.references.columns ?? [relation.references.column];
  if (refColumns.length !== fields.length) return null;
  const primaryKey = referencedTable.primaryKey;
  if (
    primaryKey.length !== refColumns.length ||
    !primaryKey.every((column) => refColumns.includes(column))
  ) {
    return null;
  }

  // Assemble the item id in the target's primary-key declaration order; the
  // referencing columns may list the key in a different order.
  const components: Array<string | number> = [];
  for (const keyColumn of primaryKey) {
    const raw = row[fields[refColumns.indexOf(keyColumn)]];
    if (raw === null || raw === undefined) return null;
    if (typeof raw !== 'string' && typeof raw !== 'number') return null;
    components.push(raw);
  }

  const value = encodeResourceId(components);
  return loadRow(referencedQualifiedName, components).then((targetRow) => {
    const label = projectLabel(referencedTable, targetRow);
    out[fields[0]] = { value, label, referencedQualifiedName };
  });
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
