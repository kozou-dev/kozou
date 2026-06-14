// Detail / Delete route. Reads the row via DataAdapter.get, resolves
// each FK column to the referenced row's displayField label through
// the per-process FkRowCache, then hands the row + column metadata +
// resolved FK labels to the .svelte template. The `?/delete` form
// action calls DataAdapter.delete + redirects back to the table
// listing.
//
// FK label resolution lands here in v0.1.1. The cache keeps repeat
// renders / sibling detail pages
// from re-fetching the same target rows; lookup misses fall back to
// rendering the raw FK value.

import { error, redirect } from '@sveltejs/kit';

import type { TableContext } from '@kozou/core';

import {
  encodeResourceId,
  parseResourceId,
  resolveFkLabels,
} from '@kozou/ui-core';
import { getAdapter } from '$lib/server/adapter.js';

import type { Actions, PageServerLoad } from './$types';

function findTable(
  tables: TableContext[],
  slug: string,
): TableContext | null {
  return tables.find((t) => t.qualifiedName === slug) ?? null;
}

function tableViewModel(table: TableContext) {
  return {
    qualifiedName: table.qualifiedName,
    label: table.label,
    // Privilege-aware mode (#99): hide Delete when the serving role lacks the
    // table DELETE privilege. `undefined` (privileges not evaluated) keeps the
    // current behaviour — Delete shown.
    canDelete: table.rawTable.privileges?.delete !== false,
    columns: table.columns.map((c) => ({
      name: c.name,
      label: c.label,
      widget: c.widget,
      isPrimaryKey: c.isPrimaryKey,
      isForeignKey: c.isForeignKey,
    })),
  };
}

export const load: PageServerLoad = async ({ params, locals }) => {
  const table = findTable(locals.schema.tables, params.table);
  if (!table) {
    throw error(404, `Unknown table: ${params.table}`);
  }
  const adapter = getAdapter(locals.schema);
  const id = parseResourceId(params.id, table.primaryKey);
  const row = await adapter.get(table.qualifiedName, id);

  const fkLabels = await resolveFkLabels({
    table,
    row,
    schema: locals.schema,
    loadRow: (qualifiedName, id) =>
      locals.fkRowCache.get(qualifiedName, id, (qn, identifier) =>
        // Swallow adapter errors so a single missing target row
        // does not block the rest of the FK columns from resolving;
        // the template falls back to the raw FK value when the
        // resolved label is null.
        adapter.get(qn, identifier).catch(() => null),
      ),
  });

  return {
    table: tableViewModel(table),
    row,
    fkLabels,
    // Canonical encoded segment for edit / back links (single-key values are
    // unchanged; a composite key keeps its comma-joined form).
    id: encodeResourceId(id),
  };
};

export const actions: Actions = {
  delete: async ({ params, locals }) => {
    const table = findTable(locals.schema.tables, params.table);
    if (!table) {
      throw error(404, `Unknown table: ${params.table}`);
    }
    // Privilege-aware mode (#99): refuse a delete the serving role cannot
    // perform, instead of letting it fail at the database. `undefined` keeps
    // the current behaviour.
    if (table.rawTable.privileges?.delete === false) {
      throw error(403, `The configured role may not delete from ${table.qualifiedName}.`);
    }
    const id = parseResourceId(params.id, table.primaryKey);
    await getAdapter(locals.schema).delete(table.qualifiedName, id);
    throw redirect(303, `/tables/${table.qualifiedName}`);
  },
};
