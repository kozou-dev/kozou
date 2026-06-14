// Table list route. Resolves the table from the SchemaContext, derives the
// display columns + searchable text columns (the same route-local heuristics
// the reference UI uses), translates the URL query into a DataAdapter list
// call via @kozou/ui-core's parseListParamsFromUrl, and renders the shared
// ListTable. Read-only: no create/edit/delete (that is Phase 2).

import { notFound } from 'next/navigation';

import type { ColumnContext, TableContext } from '@kozou/core';
import { parseListParamsFromUrl } from '@kozou/ui-core';

import { getAdapter } from '@/lib/server/adapter';
import { getSchema } from '@/lib/server/schema';
import { ListTable } from '@/app/_components/ListTable';

export const dynamic = 'force-dynamic';

const DISPLAY_COLUMN_LIMIT = 5;

// Types that support a case-insensitive ILIKE substring search. `uuid` is
// deliberately excluded (PostgreSQL has no `uuid ILIKE text` operator).
const TEXT_LIKE_TYPE_PREFIXES = [
  'text',
  'character',
  'varchar',
  'citext',
  'name',
];

type SearchParams = Record<string, string | string[] | undefined>;

export default async function TableListPage({
  params,
  searchParams,
}: {
  params: Promise<{ table: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { table: tableSlug } = await params;
  const sp = await searchParams;

  const schema = await getSchema();
  const table = schema.tables.find((t) => t.qualifiedName === tableSlug);
  if (!table) notFound();

  const searchFields = pickSearchFields(table);
  const listParams = parseListParamsFromUrl({
    url: urlFromSearchParams(sp),
    searchFields,
  });

  const result = await getAdapter().list(table.qualifiedName, listParams);

  const columns = pickDisplayColumns(table).map((c) => ({
    name: c.name,
    label: c.label,
  }));

  return (
    <ListTable
      title={table.label}
      qualifiedName={table.qualifiedName}
      columns={columns}
      rows={result.rows}
      total={result.total}
      listParams={{
        search: listParams.search,
        sort: listParams.sort,
        page: listParams.page,
        pageSize: listParams.pageSize,
      }}
      basePath={`/tables/${table.qualifiedName}`}
      primaryKey={table.primaryKey}
    />
  );
}

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

// parseListParamsFromUrl only reads url.searchParams, so the host is
// arbitrary; rebuild a URL from Next's searchParams object.
function urlFromSearchParams(sp: SearchParams): URL {
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(sp)) {
    if (typeof value === 'string') usp.set(key, value);
    else if (Array.isArray(value) && value.length > 0) usp.set(key, value[0]);
  }
  return new URL(`http://localhost/?${usp.toString()}`);
}
