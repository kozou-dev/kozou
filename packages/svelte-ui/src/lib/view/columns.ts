// View display + search field pickers.
// Symmetrical to the equivalents inside the table list route, but
// kept in a separate module so the view route can stay declarative
// and the heuristics are unit-testable in isolation.

import type { ColumnContext, ViewContext } from '@kozou/core';

const DISPLAY_COLUMN_LIMIT = 5;

const TEXT_LIKE_TYPE_PREFIXES = [
  'text',
  'character',
  'varchar',
  'citext',
  'name',
  'uuid',
];

export function pickViewDisplayColumns(view: ViewContext): ColumnContext[] {
  return view.columns.slice(0, DISPLAY_COLUMN_LIMIT);
}

export function pickViewSearchFields(view: ViewContext): string[] {
  return view.columns
    .filter((c) =>
      TEXT_LIKE_TYPE_PREFIXES.some((prefix) =>
        c.dataType.toLowerCase().startsWith(prefix),
      ),
    )
    .map((c) => c.name);
}
