<script lang="ts">
  import { superForm } from 'sveltekit-superforms';

  import { resolveWidget } from '$lib/form/widget-registry.js';

  let { data } = $props();

  // svelte-ignore state_referenced_locally
  const { form, errors, enhance, submitting } = superForm(data.form, {
    dataType: 'json',
  });
</script>

<h1 class="mb-1 text-2xl font-semibold">Edit {data.table.label}</h1>
<p class="mb-6 text-sm text-muted-foreground">
  {data.table.qualifiedName} / {data.id}
</p>

<form method="POST" use:enhance class="space-y-4">
  {#each data.table.columns as col (col.name)}
    {@const Widget = resolveWidget(col.widget)}
    <div>
      <Widget
        name={col.name}
        label={col.label}
        bind:value={$form[col.name]}
        options={col.enumValues}
        required={!col.nullable && !col.readonly && !col.isPrimaryKey}
        readonly={col.readonly}
      />
      {#if $errors[col.name]}
        <p class="mt-1 text-sm text-destructive">{$errors[col.name]}</p>
      {/if}
    </div>
  {/each}

  <div class="flex gap-3">
    <button
      type="submit"
      disabled={$submitting}
      class="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
    >
      {$submitting ? 'Saving…' : 'Save'}
    </button>
    <a
      href={`/tables/${data.table.qualifiedName}/${data.id}`}
      class="rounded-md border border-border px-4 py-2 text-sm font-medium"
    >
      Cancel
    </a>
  </div>
</form>
