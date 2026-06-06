// Edit-record route. Loads the current row via DataAdapter.get,
// hydrates a zod-driven superforms form, and on submit calls
// DataAdapter.update + redirects to the detail page.
//
// See Kozou v0.1 design spec §8.3.5.

import { error, fail, redirect } from '@sveltejs/kit';
import { superValidate } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';

import type { TableContext } from '@kozou/core';

import { buildMutationPayload } from '$lib/form/mutation-payload.js';
import { zodFromTable } from '$lib/form/zod-from-table.js';
import { encodeResourceId, parseResourceId } from '$lib/resource-id.js';
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
    primaryKey: table.primaryKey,
    columns: table.columns.map((c) => ({
      name: c.name,
      label: c.label,
      widget: c.widget,
      enumValues: c.enumValues ?? [],
      nullable: c.nullable,
      readonly: c.readonly || c.isPrimaryKey,
      isPrimaryKey: c.isPrimaryKey,
    })),
  };
}

export const load: PageServerLoad = async ({ params, locals }) => {
  const table = findTable(locals.schema.tables, params.table);
  if (!table) {
    throw error(404, `Unknown table: ${params.table}`);
  }
  const id = parseResourceId(params.id, table.primaryKey);
  const row = await getAdapter(locals.schema).get(table.qualifiedName, id);
  const schema = zodFromTable(table);
  const form = await superValidate(row, zod4(schema));
  return { table: tableViewModel(table), form, id: encodeResourceId(id) };
};

export const actions: Actions = {
  default: async ({ request, params, locals }) => {
    const table = findTable(locals.schema.tables, params.table);
    if (!table) {
      throw error(404, `Unknown table: ${params.table}`);
    }
    const schema = zodFromTable(table);
    const form = await superValidate(request, zod4(schema));
    if (!form.valid) {
      return fail(400, { form });
    }
    const payload = buildMutationPayload(
      table,
      form.data as Record<string, unknown>,
    );
    const id = parseResourceId(params.id, table.primaryKey);
    await getAdapter(locals.schema).update(table.qualifiedName, id, payload);
    throw redirect(303, `/tables/${table.qualifiedName}/${encodeResourceId(id)}`);
  },
};
