<script lang="ts">
  let { data } = $props();

  const sortLookup = $derived(
    new Map(data.listParams.sort.map((s) => [s.field, s.order])),
  );

  const totalPages = $derived(
    Math.max(1, Math.ceil(data.list.total / data.list.pageSize)),
  );

  function buildHref(overrides: Record<string, string | null>): string {
    const params = new URLSearchParams();
    if (data.listParams.search.length > 0) {
      params.set('q', data.listParams.search);
    }
    if (data.listParams.sort.length > 0) {
      params.set(
        'sort',
        data.listParams.sort.map((s) => `${s.field}:${s.order}`).join(','),
      );
    }
    if (data.listParams.page > 1) {
      params.set('page', String(data.listParams.page));
    }
    if (data.listParams.pageSize !== 50) {
      params.set('pageSize', String(data.listParams.pageSize));
    }
    for (const [key, value] of Object.entries(overrides)) {
      if (value === null) {
        params.delete(key);
      } else {
        params.set(key, value);
      }
    }
    const query = params.toString();
    return query.length > 0 ? `?${query}` : '.';
  }

  function buildSortHref(field: string): string {
    const current = sortLookup.get(field);
    const next = current === 'asc' ? 'desc' : 'asc';
    return buildHref({ sort: `${field}:${next}`, page: null });
  }

  function formatCell(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  }
</script>

<h1 class="mb-1 text-2xl font-semibold">{data.view.label}</h1>
<p class="mb-6 text-sm text-muted-foreground">{data.view.qualifiedName}</p>

<form method="GET" class="mb-4 flex flex-wrap items-center gap-2">
  <input
    type="text"
    name="q"
    value={data.listParams.search}
    placeholder="Search…"
    class="min-w-0 flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm"
  />
  <button
    type="submit"
    class="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
  >
    Search
  </button>
</form>

<div class="overflow-x-auto rounded-md border border-border">
  <table class="min-w-full text-sm">
    <thead class="bg-muted">
      <tr>
        {#each data.view.columns as col (col.name)}
          <th class="px-3 py-2 text-left font-medium">
            <a href={buildSortHref(col.name)} class="hover:underline">
              {col.label}
              {#if sortLookup.has(col.name)}
                <span aria-hidden="true">{sortLookup.get(col.name) === 'asc' ? '↑' : '↓'}</span>
              {/if}
            </a>
          </th>
        {/each}
      </tr>
    </thead>
    <tbody>
      {#if data.list.rows.length === 0}
        <tr>
          <td
            colspan={data.view.columns.length}
            class="px-3 py-6 text-center text-muted-foreground"
          >
            No rows.
          </td>
        </tr>
      {:else}
        {#each data.list.rows as row, idx (idx)}
          <tr class="border-t border-border">
            {#each data.view.columns as col (col.name)}
              <td class="px-3 py-2">{formatCell(row[col.name])}</td>
            {/each}
          </tr>
        {/each}
      {/if}
    </tbody>
  </table>
</div>

<nav class="mt-4 flex items-center justify-between text-sm">
  <span class="text-muted-foreground">
    Page {data.listParams.page} of {totalPages} ({data.list.total} total)
  </span>
  <div class="flex gap-2">
    {#if data.listParams.page > 1}
      <a
        href={buildHref({ page: String(data.listParams.page - 1) })}
        class="rounded-md border border-border px-3 py-1"
      >
        ← Prev
      </a>
    {/if}
    {#if data.listParams.page < totalPages}
      <a
        href={buildHref({ page: String(data.listParams.page + 1) })}
        class="rounded-md border border-border px-3 py-1"
      >
        Next →
      </a>
    {/if}
  </div>
</nav>
