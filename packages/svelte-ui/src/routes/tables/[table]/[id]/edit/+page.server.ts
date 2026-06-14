// Edit-record route. Loads the current row via DataAdapter.get,
// hydrates a zod-driven superforms form, and on submit calls
// DataAdapter.update + redirects to the detail page.

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
import { applyPrivilegeReadonly } from '$lib/form/privilege-readonly.js';
import { zodFromTable } from '$lib/form/zod-from-table.js';
import { encodeResourceId, parseResourceId } from '@kozou/ui-core';
import { getAdapter } from '$lib/server/adapter.js';
import { readFormWithCompositePicks } from '$lib/server/composite-form.js';
import {
  ensureSelectedOptions,
  loadInitialRelationOptions,
} from '$lib/server/relation-options.js';

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
      readonly: c.readonly || c.isPrimaryKey,
      isPrimaryKey: c.isPrimaryKey,
    })),
  };
}

export const load: PageServerLoad = async ({ params, locals }) => {
  const found = findTable(locals.schema.tables, params.table);
  if (!found) {
    throw error(404, `Unknown table: ${params.table}`);
  }
  // Privilege-aware mode (#99): a column the role cannot UPDATE is read-only on
  // edit. No-op when privileges were not evaluated.
  const table = applyPrivilegeReadonly(found, 'update');
  const adapter = getAdapter(locals.schema);
  const id = parseResourceId(params.id, table.primaryKey);
  const row = await adapter.get(table.qualifiedName, id);
  const relations = relationFieldConfigs(table, locals.schema);
  const formTable = promoteCompositeMemberWidgets(
    demoteUnpickableRelations(table, relations),
    relations,
  );
  const form = await superValidate(row, zod4(zodFromTable(formTable)));
  const initialOptions = await loadInitialRelationOptions(adapter, relations);
  // Make sure the row's current foreign keys are selectable even when they
  // fall outside the first page, so saving without changing the relation
  // cannot drop the value.
  await ensureSelectedOptions(adapter, relations, row, initialOptions);
  return {
    table: tableViewModel(formTable),
    form,
    id: encodeResourceId(id),
    relations,
    initialOptions,
  };
};

export const actions: Actions = {
  default: async ({ request, params, locals }) => {
    const found = findTable(locals.schema.tables, params.table);
    if (!found) {
      throw error(404, `Unknown table: ${params.table}`);
    }
    const table = applyPrivilegeReadonly(found, 'update');
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
      'update',
    );
    const id = parseResourceId(params.id, table.primaryKey);
    await getAdapter(locals.schema).update(table.qualifiedName, id, payload);
    throw redirect(303, `/tables/${table.qualifiedName}/${encodeResourceId(id)}`);
  },
};
