// Privilege-aware read-only, applied per form mode (issue #99).
//
// When privilege-aware introspection is on, `@kozou/core` attaches the serving
// role's `insertable` / `updatable` to each column (the privilege truth) but
// deliberately leaves `readonly` sourced from UI Hints — because whether a
// column is writable depends on the mode: a column may be insertable but not
// updatable (write-once, e.g. `created_by`) or updatable but not insertable.
// So the create / edit routes fold the mode-appropriate grant into `readonly`
// here, and the rest of the form pipeline (zod schema, view model, widget
// rendering, mutation payload) keeps using the single `readonly` lever.
//
// When privileges were not evaluated (default mode) `insertable` / `updatable`
// are undefined, so this is a no-op and existing behaviour is preserved.

import type { TableContext } from '@kozou/core';

export function applyPrivilegeReadonly(
  table: TableContext,
  mode: 'create' | 'update',
): TableContext {
  return {
    ...table,
    columns: table.columns.map((c) => {
      const denied = mode === 'create' ? c.insertable === false : c.updatable === false;
      return denied && !c.readonly ? { ...c, readonly: true } : c;
    }),
  };
}
