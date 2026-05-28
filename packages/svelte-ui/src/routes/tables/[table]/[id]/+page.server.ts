// Detail / Delete route. Reads the row via DataAdapter.get, resolves
// each FK column to the referenced row's displayField label through
// the per-process FkRowCache, then hands the row + column metadata +
// resolved FK labels to the .svelte template. The `?/delete` form
// action calls DataAdapter.delete + redirects back to the table
// listing.
//
// FK label resolution lands here in v0.1.1 (Kozou v0.1 design spec
// §16.1.1 B). The cache keeps repeat renders / sibling detail pages
// from re-fetching the same target rows; lookup misses fall back to
// rendering the raw FK value.
//
// See Kozou v0.1 design spec §8.3.4.

import { error, redirect } from '@sveltejs/kit';

import type { TableContext } from '@kozou/core';

import { resolveFkLabels } from '$lib/detail/resolve-fk-labels.js';
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
  const adapter = getAdapter();
  const row = await adapter.get(table.qualifiedName, params.id);

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
    id: params.id,
  };
};

export const actions: Actions = {
  delete: async ({ params, locals }) => {
    const table = findTable(locals.schema.tables, params.table);
    if (!table) {
      throw error(404, `Unknown table: ${params.table}`);
    }
    await getAdapter().delete(table.qualifiedName, params.id);
    throw redirect(303, `/tables/${table.qualifiedName}`);
  },
};
