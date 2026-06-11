// New-record route. Builds a zod schema from the SchemaContext,
// hands it to sveltekit-superforms for client + server validation,
// and on submit calls DataAdapter.create + redirects to the
// freshly-created row's detail page.
//
// See Kozou v0.1 design spec §8.3.3.

import { error, fail, redirect } from '@sveltejs/kit';
import { superValidate } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';

import type { TableContext } from '@kozou/core';

import { buildMutationPayload } from '$lib/form/mutation-payload.js';
import {
  demoteUnpickableRelations,
  promoteCompositeMemberWidgets,
  relationFieldConfigs,
} from '$lib/form/relation-field-config.js';
import { zodFromTable } from '$lib/form/zod-from-table.js';
import { rowIdSegment } from '$lib/resource-id.js';
import { getAdapter } from '$lib/server/adapter.js';
import { readFormWithCompositePicks } from '$lib/server/composite-form.js';
import { loadInitialRelationOptions } from '$lib/server/relation-options.js';

import type { Actions, PageServerLoad } from './$types';

function findTable(
  tables: TableContext[],
  slug: string,
): TableContext | null {
  return tables.find((t) => t.qualifiedName === slug) ?? null;
}

// `table` is expected to already carry demoted widgets (see
// demoteUnpickableRelations), so the rendered widget matches the validation
// schema built from the same table.
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
  const relations = relationFieldConfigs(table, locals.schema);
  const formTable = promoteCompositeMemberWidgets(
    demoteUnpickableRelations(table, relations),
    relations,
  );
  const form = await superValidate(zod4(zodFromTable(formTable)));
  const initialOptions = await loadInitialRelationOptions(
    getAdapter(locals.schema),
    relations,
  );
  return {
    table: tableViewModel(formTable),
    form,
    relations,
    initialOptions,
  };
};

export const actions: Actions = {
  default: async ({ request, params, locals }) => {
    const table = findTable(locals.schema.tables, params.table);
    if (!table) {
      throw error(404, `Unknown table: ${params.table}`);
    }
    const relations = relationFieldConfigs(table, locals.schema);
    const formTable = promoteCompositeMemberWidgets(
      demoteUnpickableRelations(table, relations),
      relations,
    );
    // A native (non-enhanced) submission carries each composite pick as one
    // encoded control; decode it into the component fields first. A
    // malformed control (crafted / corrupted) is rejected outright — letting
    // it fall through to the schema defaults would silently clear an
    // optional relation.
    const submission = await readFormWithCompositePicks(request, relations);
    if (submission === null) {
      return fail(400, {
        form: await superValidate(zod4(zodFromTable(formTable))),
      });
    }
    const form = await superValidate(submission, zod4(zodFromTable(formTable)));
    if (!form.valid) {
      return fail(400, { form });
    }
    const payload = buildMutationPayload(
      formTable,
      form.data as Record<string, unknown>,
    );
    const created = await getAdapter(locals.schema).create(
      table.qualifiedName,
      payload,
    );
    // Build the detail link from the created row's key columns (a composite
    // key joins them; an empty/incomplete key falls back to the listing).
    const segment = rowIdSegment(created, table.primaryKey);
    throw redirect(
      303,
      segment !== null
        ? `/tables/${table.qualifiedName}/${segment}`
        : `/tables/${table.qualifiedName}`,
    );
  },
};
