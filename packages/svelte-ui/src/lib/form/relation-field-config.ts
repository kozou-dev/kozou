// Derive the relation-select picker config for each foreign key on a table:
// which target resource the picker searches, which column to show as each
// option's label, and which target columns the live search filters on.
//
// A single-column relation maps its foreign-key column to the referenced
// table's displayField. A composite (multi-column) relation maps its column
// group to one picker that fills every component at once. The picker is
// enabled only when:
//  - the relation references the target's primary key — both adapters'
//    searchRelation project the target primary key as each option's id, and
//    edit hydration resolves the current value by id, so a foreign key to a
//    non-PK unique constraint could not round-trip. A composite relation may
//    list the key columns in any order; the config records the mapping.
//  - the target's label column is text-searchable — otherwise the picker
//    could neither be narrowed by the live search nor paged past its first-
//    page cap, stranding values past the cap; and
//  - (composite only) no component column is shared with another picker —
//    two pickers writing the same column would race nondeterministically.
// Failing cases (plus relations whose target table is absent) leave the
// columns as scalar inputs the operator types instead.

import type {
  RelationOption,
  SchemaContext,
  TableContext,
  WidgetType,
} from '@kozou/core';

export interface RelationFieldConfig {
  /** The foreign-key column on the table being edited. For a composite
   *  relation, the first column in foreign-key declaration order — the key
   *  under which the picker's options are stored. */
  field: string;
  /** All foreign-key columns, in declaration order. Optional so pre-composite
   *  shapes stay valid; readers normalize with `?? [field]`. */
  fields?: string[];
  /** The same columns reordered to the target's primary-key declaration
   *  order, so `keyFields[i]` receives component `i` of an option id (the
   *  order a composite ResourceId uses). Optional; readers normalize with
   *  `?? [field]`. */
  keyFields?: string[];
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

/**
 * Whether an option can round-trip through the picker contract. A key
 * containing an EMPTY-STRING component collides with the contract's ''
 * unselected sentinel — picking it would corrupt the write (the component
 * would be normalized to null) — so such options are not offered (a
 * documented limitation, see {@link promoteCompositeMemberWidgets}).
 */
export function isPickableOption(option: RelationOption): boolean {
  const components = Array.isArray(option.id) ? option.id : [option.id];
  return components.every((part) => part !== '');
}

/**
 * The composite picker's explicit clear value. The empty string cannot mean
 * "clear" on the native path: an unselected (e.g. partial-null) current
 * value renders the select at '' too, and an untouched no-JS save must keep
 * the baseline values rather than erase them. A real composite option value
 * always contains a comma (two or more components), so this marker cannot
 * collide with one.
 */
export const COMPOSITE_CLEAR_VALUE = '__clear__';

/**
 * Name of the single form control a composite picker submits. A no-JS
 * (non-enhanced) submission cannot fan the selection out to the component
 * fields itself, so the picker's `<select>` carries the canonical encoded id
 * under this synthetic name and the server decodes it into the component
 * fields ahead of validation (see `readFormWithCompositePicks`). The enhanced
 * path ignores it (the form store travels in superforms' JSON envelope).
 */
export function compositeParamName(field: string): string {
  return `__composite__${field}`;
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

/** Resolve the searchable label column of a picker target, or `null` when the
 *  picker would be unusable (no text-searchable label). */
function searchableLabel(
  target: TableContext,
): { labelField: string; searchFields: string[] } | null {
  const labelField = target.displayField ?? target.primaryKey[0];
  const labelColumn = target.columns.find((c) => c.name === labelField);
  // The picker searches the label column, and the first page is capped. A
  // non-text-searchable label (e.g. a uuid primary key with no name column)
  // could neither be narrowed nor paged past the cap, stranding valid values
  // past the first page — so leave the columns as scalar inputs instead.
  if (labelColumn === undefined || !isTextSearchable(labelColumn.dataType)) {
    return null;
  }
  return { labelField, searchFields: [labelField] };
}

export function relationFieldConfigs(
  table: TableContext,
  schema: SchemaContext,
): RelationFieldConfig[] {
  const configs: RelationFieldConfig[] = [];

  for (const relation of table.relations) {
    const fields = relation.fields ?? [relation.field];
    const referencedColumns = relation.references.columns ?? [
      relation.references.column,
    ];
    if (referencedColumns.length !== fields.length) continue;

    const resource = `${relation.references.schema}.${relation.references.table}`;
    const target = schema.tables.find((t) => t.qualifiedName === resource);
    if (target === undefined) continue;

    // The option id is the target's primary key, so the picker can only
    // represent a foreign key that references that key. A composite relation
    // may list the key columns in any order, as long as it covers the key.
    const primaryKey = target.primaryKey;
    if (
      primaryKey.length !== referencedColumns.length ||
      !primaryKey.every((column) => referencedColumns.includes(column))
    ) {
      continue;
    }

    const label = searchableLabel(target);
    if (label === null) continue;

    if (fields.length === 1) {
      configs.push({ field: fields[0], resource, ...label });
      continue;
    }

    // The picker's native submission travels under a synthetic field name;
    // a real column with that name would collide with it, so such a (wildly
    // unconventional) schema keeps scalar inputs instead.
    if (
      table.columns.some((c) => c.name === compositeParamName(fields[0]))
    ) {
      continue;
    }

    // `keyFields[i]` is the foreign-key column matched to primary-key column
    // `i`, so an option id (in key declaration order) fans out positionally.
    const keyFields = primaryKey.map(
      (column) => fields[referencedColumns.indexOf(column)],
    );
    configs.push({
      field: fields[0],
      fields: [...fields],
      keyFields,
      resource,
      ...label,
    });
  }

  // A composite picker owns every column it writes. If any of its columns
  // also participates in ANOTHER foreign key — picker-eligible or not — a
  // pick could rewrite a column shared with that relation while the
  // relation's other components stay stale (a wrong cross-row association),
  // so the composite config is dropped deterministically and those columns
  // stay scalar inputs. The claims therefore count EVERY relation on the
  // table, not just the accepted picker configs. Single-column configs keep
  // their existing behaviour.
  const claims = new Map<string, number>();
  for (const relation of table.relations) {
    for (const field of relation.fields ?? [relation.field]) {
      claims.set(field, (claims.get(field) ?? 0) + 1);
    }
  }
  return configs.filter((config) => {
    const fields = config.fields ?? [config.field];
    if (fields.length === 1) return true;
    return fields.every((field) => claims.get(field) === 1);
  });
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
 * Composite foreign-key columns are untouched: core never marks them
 * `relation-select` (they carry type-based scalar widgets), and the composite
 * picker writes through those scalar fields rather than replacing them.
 */
export function demoteUnpickableRelations(
  table: TableContext,
  relations: RelationFieldConfig[],
): TableContext {
  const pickable = new Set(
    relations
      .filter((r) => (r.fields ?? [r.field]).length === 1)
      .map((r) => r.field),
  );
  return {
    ...table,
    columns: table.columns.map((c) =>
      c.widget === 'relation-select' && !pickable.has(c.name)
        ? { ...c, widget: scalarWidgetForDataType(c.dataType) }
        : c,
    ),
  };
}

/**
 * Return a copy of `table` with every composite-picker component column
 * switched to the `relation-select` widget, so the form layer treats it as a
 * picker-held value rather than a typed scalar input:
 *
 *  - zodFromColumn applies the picker semantics: the unselected default is
 *    `''` and a required component rejects an empty submission — without
 *    this, superforms initializes an absent required numeric component to
 *    `0`, and the suppressed (never-rendered) member columns would silently
 *    submit a fabricated `(0, 0, ...)` reference;
 *  - buildMutationPayload normalizes `''` to null (or drops it for a
 *    DB-supplied column) instead of letting it coerce.
 *
 * The columns themselves are never rendered — the composite picker replaces
 * them — so the widget change is purely a validation / payload contract.
 * Apply AFTER {@link demoteUnpickableRelations} (which would demote the
 * promoted members straight back).
 *
 * Known limitation: the contract reserves '' as the unselected sentinel
 * (matching the single-column picker), so a key that contains an
 * EMPTY-STRING component cannot round-trip through the form — a required
 * component rejects it and an optional one normalizes it to null. The
 * picker therefore does not offer such options ({@link isPickableOption}),
 * the native decoder treats them as malformed, and the current-value seeding
 * skips them; an untouched edit save of a row already holding such a key
 * still normalizes the '' component (this predates composite support — the
 * single-column picker has the same property). Such keys are pathological
 * schema design and remain manageable through the API.
 */
export function promoteCompositeMemberWidgets(
  table: TableContext,
  relations: RelationFieldConfig[],
): TableContext {
  const members = new Set<string>();
  for (const config of relations) {
    const fields = config.fields ?? [config.field];
    if (fields.length < 2) continue;
    for (const field of fields) members.add(field);
  }
  if (members.size === 0) return table;
  return {
    ...table,
    columns: table.columns.map((c) =>
      members.has(c.name) ? { ...c, widget: 'relation-select' } : c,
    ),
  };
}
