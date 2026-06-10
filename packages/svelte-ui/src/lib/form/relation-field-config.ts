// Derive the relation-select picker config for each single-column foreign
// key on a table: which target resource the picker searches, which column
// to show as each option's label, and which target columns the live search
// filters on.
//
// A single-column relation maps its foreign-key column to the referenced
// table's displayField. The picker is enabled only when:
//  - the relation references the target's single-column primary key — both
//    adapters' searchRelation project the target primary key as each option's
//    id, and edit hydration resolves the current value by id, so a foreign key
//    to a non-PK unique column could not round-trip; and
//  - the target's label column is text-searchable — otherwise the picker
//    could neither be narrowed by the live search nor paged past its first-
//    page cap, stranding values past the cap.
// Both cases (plus composite foreign keys, deferred to a later stage per Kozou
// v1.0 dev spec §5.2, and relations whose target table is absent) leave the
// column as a scalar input the operator types instead.

import type { SchemaContext, TableContext, WidgetType } from '@kozou/core';

export interface RelationFieldConfig {
  /** The foreign-key column on the table being edited. */
  field: string;
  /** "schema.table" of the referenced table the picker searches. */
  resource: string;
  /** Column on the target shown as each option's label. */
  labelField: string;
  /** Target columns the live search filters on. Empty when the label column
   *  is not text-searchable (e.g. a uuid surrogate key fallback), so the
   *  picker lists rows without offering a substring search that the backend
   *  would reject. */
  searchFields: string[];
}

// Base scalar types that accept ILIKE, mirroring @kozou/api's text-like gate
// (it pre-flights a non-text search field to a 400). Exact-match on the
// normalized base type, so array spellings like `text[]` are excluded.
const TEXT_LIKE_BASE_TYPES = new Set([
  'text',
  'character varying',
  'varchar',
  'character',
  'char',
  'bpchar',
  'citext',
  'name',
]);

// Keep substring search off non-text labels so the initial option load and the
// live search both stay within what the backend accepts. Lower-cases, rejects
// any array spelling, and drops a trailing length/precision modifier
// (`character varying(255)` -> `character varying`) before the exact match. No
// regex (linear scan), matching the @kozou/api predicate.
function isTextSearchable(dataType: string): boolean {
  const lower = dataType.trim().toLowerCase();
  if (lower.includes('[')) return false; // array spelling, e.g. text[]
  const paren = lower.indexOf('(');
  const base = (paren === -1 ? lower : lower.slice(0, paren)).trim();
  return TEXT_LIKE_BASE_TYPES.has(base);
}

export function relationFieldConfigs(
  table: TableContext,
  schema: SchemaContext,
): RelationFieldConfig[] {
  const configs: RelationFieldConfig[] = [];

  for (const relation of table.relations) {
    const fields = relation.fields ?? [relation.field];
    // Single-column relations only; composite foreign keys are a later stage.
    if (fields.length !== 1) continue;
    const field = fields[0];
    const referencedColumns = relation.references.columns ?? [
      relation.references.column,
    ];
    const referencedColumn = referencedColumns[0];

    const resource = `${relation.references.schema}.${relation.references.table}`;
    const target = schema.tables.find((t) => t.qualifiedName === resource);
    if (target === undefined) continue;

    // The option id is the target's primary key, so the picker can only
    // represent a foreign key that references that single-column primary key.
    if (
      target.primaryKey.length !== 1 ||
      target.primaryKey[0] !== referencedColumn
    ) {
      continue;
    }

    const labelField = target.displayField ?? target.primaryKey[0];
    const labelColumn = target.columns.find((c) => c.name === labelField);
    // The picker searches the label column, and the first page is capped. A
    // non-text-searchable label (e.g. a uuid primary key with no name column)
    // could neither be narrowed nor paged past the cap, stranding valid values
    // past the first page — so leave it as a scalar input the operator types.
    if (labelColumn === undefined || !isTextSearchable(labelColumn.dataType)) {
      continue;
    }

    configs.push({ field, resource, labelField, searchFields: [labelField] });
  }

  return configs;
}

/**
 * Pick a scalar input widget for a column from its `dataType`.
 *
 * Used to demote a single-column foreign key that core marked `relation-select`
 * but that has no usable picker config (it references a non-PK unique column).
 * Without this it would render an empty, unselectable relation dropdown; the
 * scalar input lets the operator type the raw value instead. Mirrors the
 * type-based arm of core's widget inference, but keyed on the formatted
 * `dataType` exposed on `ColumnContext`.
 */
export function scalarWidgetForDataType(dataType: string): WidgetType {
  const type = dataType.toLowerCase();
  if (type === 'uuid') return 'uuid';
  if (type === 'boolean' || type === 'bool') return 'boolean';
  if (type === 'date') return 'date';
  if (type.includes('timestamp') || type.startsWith('time')) return 'datetime';
  if (type === 'json' || type === 'jsonb') return 'json';
  if (
    type.includes('int') || // integer, bigint, smallint
    type.includes('numeric') ||
    type.includes('decimal') ||
    type.includes('double') ||
    type === 'real'
  ) {
    return 'number';
  }
  return 'text';
}

/**
 * Return a copy of `table` with each unpickable single-column relation-select
 * column demoted to a scalar widget (see {@link scalarWidgetForDataType}).
 *
 * The create / edit routes build BOTH the rendered widget and the zod
 * validation schema from this, so a demoted field validates as the scalar type
 * the operator actually sees rather than the loose relation-select union.
 */
export function demoteUnpickableRelations(
  table: TableContext,
  relations: RelationFieldConfig[],
): TableContext {
  const pickable = new Set(relations.map((r) => r.field));
  return {
    ...table,
    columns: table.columns.map((c) =>
      c.widget === 'relation-select' && !pickable.has(c.name)
        ? { ...c, widget: scalarWidgetForDataType(c.dataType) }
        : c,
    ),
  };
}
