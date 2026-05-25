// Detail / Delete route. Reads the row via DataAdapter.get, hands
// it (plus the column metadata) to the .svelte template, and
// exposes a `?/delete` form action that calls DataAdapter.delete
// + redirects back to the table listing.
//
// FK label resolution (Plan §6-K "FK label 解決") is deferred to
// v0.1.1: the detail page renders the raw FK column value for
// now. Resolving each FK to its target row's displayField label
// would require N extra adapter.get / .searchRelation calls per
// detail render; v0.1.1 will batch them via /admin/refresh +
// hooks.server caching (Kozou v0.1 design spec §16.1.1 B).
//
// See Kozou v0.1 design spec §8.3.4.

import { error, redirect } from '@sveltejs/kit';

import type { TableContext } from '@kozou/core';

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
  const row = await getAdapter().get(table.qualifiedName, params.id);
  return {
    table: tableViewModel(table),
    row,
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
