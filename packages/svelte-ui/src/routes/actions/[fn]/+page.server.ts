// Action route for an exposed RPC function (issue #103).
// Builds an argument form from the function's signature — reusing the table
// form pipeline via a synthetic column set (see action-form.ts) — and on
// submit calls DataAdapter.callFunction and shows the result. Works with and
// without JavaScript: the single-column relation-select arguments submit as
// plain form fields, so no composite decoding is needed.

import { error, fail } from '@sveltejs/kit';
import { superValidate } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';

import type { FunctionContext } from '@kozou/core';

import { buildActionForm } from '$lib/form/action-form.js';
import { buildMutationPayload } from '$lib/form/mutation-payload.js';
import { zodFromTable } from '$lib/form/zod-from-table.js';
import { getAdapter } from '$lib/server/adapter.js';
import { readActionFormSubmission } from '$lib/server/composite-form.js';
import { loadInitialRelationOptions } from '$lib/server/relation-options.js';

import type { Actions, PageServerLoad } from './$types';

/** Resolve the exposed function, 404ing both when it is absent and when the
 *  backend cannot invoke it (no enumeration channel, and no dead form). */
function resolveExposedFunction(
  functions: FunctionContext[] | undefined,
  slug: string,
  canCall: boolean,
): FunctionContext {
  if (!canCall) {
    throw error(404, 'RPC actions are not available on this backend.');
  }
  const fn = (functions ?? []).find((f) => f.qualifiedName === slug);
  if (fn === undefined) {
    throw error(404, `Unknown action: ${slug}`);
  }
  return fn;
}

export const load: PageServerLoad = async ({ params, locals }) => {
  const adapter = getAdapter(locals.schema);
  const fn = resolveExposedFunction(
    locals.schema.functions,
    params.fn,
    typeof adapter.callFunction === 'function',
  );
  const action = buildActionForm(fn, locals.schema);
  const form = await superValidate(zod4(zodFromTable({ columns: action.columns })));
  const initialOptions = await loadInitialRelationOptions(adapter, action.relations);
  return {
    action: action.view,
    form,
    relations: action.relations,
    initialOptions,
  };
};

export const actions: Actions = {
  default: async ({ request, params, locals }) => {
    const adapter = getAdapter(locals.schema);
    const fn = resolveExposedFunction(
      locals.schema.functions,
      params.fn,
      typeof adapter.callFunction === 'function',
    );
    const action = buildActionForm(fn, locals.schema);
    // Convert a native (no-JS) FormData submission to a plain object first: a
    // defaulted argument's schema is a multi-type union, which superforms
    // rejects when parsing FormData directly. The enhanced path's JSON
    // envelope passes through untouched.
    const submission = await readActionFormSubmission(request);
    const form = await superValidate(submission, zod4(zodFromTable({ columns: action.columns })));
    if (!form.valid) {
      return fail(400, { form });
    }
    // Build the named-args body. `mode: 'create'` drops a defaulted-and-empty
    // argument so PostgreSQL applies the function's DEFAULT.
    const args = buildMutationPayload(
      { columns: action.columns },
      form.data as Record<string, unknown>,
    );
    try {
      // callFunction is present — resolveExposedFunction already gated on it.
      const result = await adapter.callFunction!(fn.qualifiedName, args);
      return { form, rpcOk: true, rpcResult: result ?? null };
    } catch (err) {
      // Surface the backend's mapped status (403 no EXECUTE / RLS, 409
      // conflict, 400 validation, ...) without leaking raw database text. The
      // adapter error carries a numeric `status`; read it structurally so the
      // route does not import a concrete adapter type.
      const raw = (err as { status?: unknown }).status;
      const status = typeof raw === 'number' && raw >= 400 && raw < 600 ? raw : 500;
      return fail(status, { form, rpcError: rpcErrorMessage(status) });
    }
  },
};

function rpcErrorMessage(status: number): string {
  switch (status) {
    case 400:
      return 'The action rejected the supplied arguments.';
    case 403:
      return 'You do not have permission to run this action.';
    case 404:
      return 'The action no longer exists.';
    case 409:
      return 'The action conflicted with the current data (a constraint was violated).';
    default:
      return 'The action failed. See the server logs for details.';
  }
}
