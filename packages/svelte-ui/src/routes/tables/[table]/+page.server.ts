// Table list route loader. Resolves the table by qualifiedName,
// picks display columns + searchable text columns from the schema,
// translates URL params into a DataAdapter list call, and ships
// the result to the .svelte template.
//
// See Kozou v0.1 design spec §8.3.2.

import { error } from '@sveltejs/kit';

import type { ColumnContext, TableContext } from '@kozou/core';

import { getAdapter } from '$lib/server/adapter.js';
import { parseListParamsFromUrl } from '$lib/query/list-params.js';

import type { PageServerLoad } from './$types';

const DISPLAY_COLUMN_LIMIT = 5;

const TEXT_LIKE_TYPE_PREFIXES = ['text', 'character', 'varchar', 'citext', 'name', 'uuid'];

export const load: PageServerLoad = async ({ params, locals, url }) => {
  const table = locals.schema.tables.find(
    (t) => t.qualifiedName === params.table,
  );
  if (!table) {
    throw error(404, `Unknown table: ${params.table}`);
  }

  const displayColumns = pickDisplayColumns(table);
  const searchFields = pickSearchFields(table);
  const listParams = parseListParamsFromUrl({ url, searchFields });

  const result = await getAdapter().list(table.qualifiedName, listParams);

  return {
    table: {
      qualifiedName: table.qualifiedName,
      label: table.label,
      primaryKey: table.primaryKey,
      displayField: table.displayField,
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

function pickDisplayColumns(table: TableContext): ColumnContext[] {
  const display = table.displayField;
  const ordered = [...table.columns].sort((a, b) => {
    if (a.name === display && b.name !== display) return -1;
    if (b.name === display && a.name !== display) return 1;
    return 0;
  });
  return ordered.slice(0, DISPLAY_COLUMN_LIMIT);
}

function pickSearchFields(table: TableContext): string[] {
  return table.columns
    .filter((c) =>
      TEXT_LIKE_TYPE_PREFIXES.some((prefix) =>
        c.dataType.toLowerCase().startsWith(prefix),
      ),
    )
    .map((c) => c.name);
}
