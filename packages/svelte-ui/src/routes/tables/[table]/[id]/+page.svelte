<script lang="ts">
  import { enhance } from '$app/forms';

  import { formatCellValue } from '@kozou/ui-core';

  // `form` is the action result; surface a message returned by a rejected
  // delete (e.g. a foreign-key restriction) instead of a generic 500 (#170).
  let { data, form } = $props();
</script>

<h1 class="mb-1 text-2xl font-semibold">{data.table.label}</h1>
<p class="mb-6 text-sm text-muted-foreground">
  {data.table.qualifiedName} / {data.id}
</p>

<dl class="space-y-4">
  {#each data.table.columns as col (col.name)}
    {@const rawValue = data.row[col.name]}
    {@const fkLabel = data.fkLabels[col.name]}
    <div>
      <dt class="text-sm font-medium text-muted-foreground">{col.label}</dt>
      <dd class="mt-1 text-sm">
        {#if col.widget === 'json'}
          <pre
            class="overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs"
          >{formatCellValue({ value: rawValue, widget: col.widget })}</pre>
        {:else if col.widget === 'image-url' && rawValue}
          <img
            src={String(rawValue)}
            alt={col.label}
            class="max-h-48 rounded-md border border-border object-contain"
            loading="lazy"
          />
        {:else if rawValue === null || rawValue === undefined}
          <span class="text-muted-foreground">—</span>
        {:else if fkLabel !== undefined && fkLabel.label !== null}
          <a
            href={`/tables/${fkLabel.referencedQualifiedName}/${fkLabel.value}`}
            class="text-primary underline"
          >
            {fkLabel.label}
          </a>
          <span class="ml-1 text-xs text-muted-foreground"
            >({formatCellValue({ value: rawValue, widget: col.widget })})</span
          >
        {:else}
          {formatCellValue({ value: rawValue, widget: col.widget })}
        {/if}
      </dd>
    </div>
  {/each}
</dl>

{#if form?.message}
  <p
    role="alert"
    class="mt-8 rounded-md border border-destructive bg-destructive/10 px-3 py-2 text-sm text-destructive"
  >
    {form.message}
  </p>
{/if}

<div class="mt-8 flex flex-wrap gap-3">
  <a
    href={`/tables/${data.table.qualifiedName}/${data.id}/edit`}
    class="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
  >
    Edit
  </a>
  {#if data.table.canDelete}
    <form method="POST" action="?/delete" use:enhance>
      <button
        type="submit"
        class="rounded-md border border-destructive px-4 py-2 text-sm font-medium text-destructive"
      >
        Delete
      </button>
    </form>
  {/if}
  <a
    href={`/tables/${data.table.qualifiedName}`}
    class="rounded-md border border-border px-4 py-2 text-sm font-medium"
  >
    Back
  </a>
</div>
