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
import { adapterErrorToFailure } from '$lib/server/adapter-error.js';
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
    // A database rejection (unique / FK / CHECK violation, privilege / RLS
    // denial) surfaces as an AdapterError. Re-render the form with the user's
    // input and a readable message instead of a generic 500 that discards it;
    // a non-recoverable error (5xx / network) propagates unchanged.
    try {
      await getAdapter(locals.schema).update(table.qualifiedName, id, payload);
    } catch (err) {
      const failure = adapterErrorToFailure(err);
      if (failure !== null) {
        // Surface the message through superforms' status-message channel (the
        // form's `message` field), and mark the form invalid so it re-renders
        // with the user's input on BOTH the enhanced and the no-JS paths —
        // the same failure shape as a validation failure (a `valid` form
        // returned via `fail` can be reset to the current row on SSR).
        form.valid = false;
        form.message = failure.message;
        return fail(failure.status, { form });
      }
      throw err;
    }
    throw redirect(303, `/tables/${table.qualifiedName}/${encodeResourceId(id)}`);
  },
};
