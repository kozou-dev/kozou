// Read-only VIEW listing. Same URL contract as the table list
// (see src/lib/query/list-params.ts), but no Edit / New / Delete
// buttons render in the template; views are derived data.

import { error } from '@sveltejs/kit';

import {
  pickViewDisplayColumns,
  pickViewSearchFields,
} from '$lib/view/columns.js';
import { parseListParamsFromUrl } from '$lib/query/list-params.js';
import { getAdapter } from '$lib/server/adapter.js';

import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, locals, url }) => {
  const view = locals.schema.views.find(
    (v) => v.qualifiedName === params.view,
  );
  if (!view) {
    throw error(404, `Unknown view: ${params.view}`);
  }

  const displayColumns = pickViewDisplayColumns(view);
  const searchFields = pickViewSearchFields(view);
  const listParams = parseListParamsFromUrl({ url, searchFields });

  const result = await getAdapter(locals.schema).list(
    view.qualifiedName,
    listParams,
  );

  return {
    view: {
      qualifiedName: view.qualifiedName,
      label: view.label,
      columns: displayColumns.map((c) => ({ name: c.name, label: c.label })),
    },
    list: result,
    listParams: {
      search: listParams.search,
      sort: listParams.sort,
      page: listParams.page,
      pageSize: listParams.pageSize,
    },
  };
};
