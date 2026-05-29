// New-record route. Builds a zod schema from the SchemaContext,
// hands it to sveltekit-superforms for client + server validation,
// and on submit calls DataAdapter.create + redirects to the
// freshly-created row's detail page.
//
// See Kozou v0.1 design spec §8.3.3.

import { error, fail, redirect } from '@sveltejs/kit';
import { superValidate } from 'sveltekit-superforms';
import { zod } from 'sveltekit-superforms/adapters';

import type { TableContext } from '@kozou/core';

import { buildMutationPayload } from '$lib/form/mutation-payload.js';
import { zodFromTable } from '$lib/form/zod-from-table.js';
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
      readonly: c.readonly || (c.isPrimaryKey && c.defaultExpr !== null),
      isPrimaryKey: c.isPrimaryKey,
    })),
  };
}

export const load: PageServerLoad = async ({ params, locals }) => {
  const table = findTable(locals.schema.tables, params.table);
  if (!table) {
    throw error(404, `Unknown table: ${params.table}`);
  }
  const schema = zodFromTable(table);
  const form = await superValidate(zod(schema));
  return { table: tableViewModel(table), form };
};

export const actions: Actions = {
  default: async ({ request, params, locals }) => {
    const table = findTable(locals.schema.tables, params.table);
    if (!table) {
      throw error(404, `Unknown table: ${params.table}`);
    }
    const schema = zodFromTable(table);
    const form = await superValidate(request, zod(schema));
    if (!form.valid) {
      return fail(400, { form });
    }
    const payload = buildMutationPayload(
      table,
      form.data as Record<string, unknown>,
    );
    const created = await getAdapter().create(table.qualifiedName, payload);
    const pkField = table.primaryKey[0];
    const id =
      pkField !== undefined && created[pkField] !== undefined
        ? String(created[pkField])
        : '';
    throw redirect(
      303,
      id.length > 0
        ? `/tables/${table.qualifiedName}/${id}`
        : `/tables/${table.qualifiedName}`,
    );
  },
};
