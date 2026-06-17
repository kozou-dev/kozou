<script lang="ts">
  import {
    buildHref,
    buildSortHref,
    formatCell,
    rowIdSegment,
    type ListViewParams,
  } from '@kozou/ui-core';

  interface ListColumn {
    name: string;
    label: string;
  }

  interface Props {
    /** Heading text (table / view label). */
    title: string;
    /** `schema.name`, shown under the heading. */
    qualifiedName: string;
    columns: ListColumn[];
    rows: Record<string, unknown>[];
    total: number;
    listParams: ListViewParams;
    /** Views render read-only: no "+ New", per-row links, or Actions
     *  column. */
    readonly?: boolean;
    /** Route base for the "+ New" and per-row links (e.g. `/tables/<qn>`);
     *  used only when `readonly` is false. */
    basePath?: string;
    /** Primary-key column names used to build the per-row link target. */
    primaryKey?: string[];
  }

  let {
    title,
    qualifiedName,
    columns,
    rows,
    total,
    listParams,
    readonly = false,
    basePath,
    primaryKey = [],
  }: Props = $props();

  // First occurrence of a field wins, so the visual ↑/↓ indicator agrees with
  // `primarySort` (and with the database, where `ORDER BY x ASC, x DESC` is
  // dominated by the first key) even on a degenerate `?sort=x:asc,x:desc` URL.
  // Reversing before building the Map makes the earliest entry the last write.
  const sortLookup = $derived(
    new Map([...listParams.sort].reverse().map((s) => [s.field, s.order])),
  );
  // The URL contract allows a multi-column sort (`?sort=a:asc,b:desc`), but
  // ARIA wants at most one active `aria-sort` per table — the primary one. So
  // the visual ↑/↓ indicator follows every sorted column (`sortLookup`), while
  // `aria-sort` is announced only for the first sort field; all others read
  // `none`.
  const primarySort = $derived(listParams.sort[0]);
  const totalPages = $derived(
    Math.max(1, Math.ceil(total / listParams.pageSize)),
  );

  // The `[id]` path segment for a row: a single key is the encoded value, a
  // composite key joins its columns. Used
  // both as the keyed-`{#each}` key and the per-row link target; falls back to
  // the row index when the key is absent (e.g. a view).
  function rowKey(row: Record<string, unknown>, idx: number): string {
    return rowIdSegment(row, primaryKey) ?? String(idx);
  }
</script>

<h1 class="mb-1 text-2xl font-semibold">{title}</h1>
<p class="mb-6 text-sm text-muted-foreground">{qualifiedName}</p>

<form method="GET" class="mb-4 flex flex-wrap items-center gap-2">
  <input
    type="text"
    name="q"
    value={listParams.search}
    placeholder="Search…"
    aria-label="Search rows"
    class="min-w-0 flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm"
  />
  <button
    type="submit"
    class="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
  >
    Search
  </button>
  {#if !readonly && basePath}
    <a
      href={`${basePath}/new`}
      class="rounded-md border border-border px-4 py-2 text-sm font-medium"
    >
      + New
    </a>
  {/if}
</form>

<div class="overflow-x-auto rounded-md border border-border">
  <table class="min-w-full text-sm">
    <thead class="bg-muted">
      <tr>
        {#each columns as col (col.name)}
          <th
            class="px-3 py-2 text-left font-medium"
            aria-sort={primarySort?.field === col.name
              ? primarySort.order === 'asc'
                ? 'ascending'
                : 'descending'
              : 'none'}
          >
            <a href={buildSortHref(listParams, col.name)} class="hover:underline">
              {col.label}
              {#if sortLookup.has(col.name)}
                <span aria-hidden="true">{sortLookup.get(col.name) === 'asc' ? '↑' : '↓'}</span>
              {/if}
            </a>
          </th>
        {/each}
        {#if !readonly}
          <th class="px-3 py-2 text-left font-medium">Actions</th>
        {/if}
      </tr>
    </thead>
    <tbody>
      {#if rows.length === 0}
        <tr>
          <td
            colspan={columns.length + (readonly ? 0 : 1)}
            class="px-3 py-6 text-center text-muted-foreground"
          >
            No rows.
          </td>
        </tr>
      {:else}
        {#each rows as row, idx (rowKey(row, idx))}
          <tr class="border-t border-border">
            {#each columns as col (col.name)}
              <td class="px-3 py-2">{formatCell(row[col.name])}</td>
            {/each}
            {#if !readonly && basePath}
              <td class="px-3 py-2">
                <a
                  href={`${basePath}/${rowKey(row, idx)}`}
                  class="text-primary underline"
                >
                  View
                </a>
              </td>
            {/if}
          </tr>
        {/each}
      {/if}
    </tbody>
  </table>
</div>

<nav class="mt-4 flex items-center justify-between text-sm">
  <span class="text-muted-foreground">
    Page {listParams.page} of {totalPages} ({total} total)
  </span>
  <div class="flex gap-2">
    {#if listParams.page > 1}
      <a
        href={buildHref(listParams, { page: String(listParams.page - 1) })}
        class="rounded-md border border-border px-3 py-1"
      >
        ← Prev
      </a>
    {/if}
    {#if listParams.page < totalPages}
      <a
        href={buildHref(listParams, { page: String(listParams.page + 1) })}
        class="rounded-md border border-border px-3 py-1"
      >
        Next →
      </a>
    {/if}
  </div>
</nav>
