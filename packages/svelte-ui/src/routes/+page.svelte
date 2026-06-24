<script lang="ts">
  let { data } = $props();
</script>

<h1 class="mb-6 text-2xl font-semibold">Dashboard</h1>

<a
  href="/connect"
  class="mb-10 block rounded-md border border-border p-4 transition hover:bg-muted"
>
  <div class="font-medium">Connect an AI agent →</div>
  <div class="text-sm text-muted-foreground">
    Let Claude or Cursor read this schema's meaning over MCP (read-only). Copy a
    config, paste it into your client — no setup beyond that.
  </div>
</a>

<section class="mb-10">
  <h2 class="mb-3 text-lg font-semibold">Tables</h2>
  {#if data.dashboard.tables.length === 0}
    <p class="text-sm text-muted-foreground">No tables in the current schema.</p>
  {:else}
    <ul class="space-y-2">
      {#each data.dashboard.tables as table (table.qualifiedName)}
        <li>
          <a
            href={`/tables/${table.qualifiedName}`}
            class="block rounded-md border border-border p-3 transition hover:bg-muted"
          >
            <div class="font-medium">{table.label}</div>
            {#if table.description}
              <div class="text-sm text-muted-foreground">{table.description}</div>
            {/if}
          </a>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<section class="mb-10">
  <h2 class="mb-3 text-lg font-semibold">Views</h2>
  {#if data.dashboard.views.length === 0}
    <p class="text-sm text-muted-foreground">No views in the current schema.</p>
  {:else}
    <ul class="space-y-2">
      {#each data.dashboard.views as view (view.qualifiedName)}
        <li>
          <a
            href={`/views/${view.qualifiedName}`}
            class="block rounded-md border border-border p-3 transition hover:bg-muted"
          >
            <div class="font-medium">{view.label}</div>
            {#if view.description}
              <div class="text-sm text-muted-foreground">{view.description}</div>
            {/if}
          </a>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<!-- Actions surface (issue #103): only shown when the backend serves /rpc/
     and at least one function is exposed. -->
{#if data.actionsEnabled && data.dashboard.functions.length > 0}
  <section>
    <h2 class="mb-3 text-lg font-semibold">Actions</h2>
    <ul class="space-y-2">
      {#each data.dashboard.functions as fn (fn.qualifiedName)}
        <li>
          <a
            href={`/actions/${fn.qualifiedName}`}
            class="block rounded-md border border-border p-3 transition hover:bg-muted"
          >
            <div class="font-medium">{fn.label}</div>
            {#if fn.description}
              <div class="text-sm text-muted-foreground">{fn.description}</div>
            {/if}
          </a>
        </li>
      {/each}
    </ul>
  </section>
{/if}
