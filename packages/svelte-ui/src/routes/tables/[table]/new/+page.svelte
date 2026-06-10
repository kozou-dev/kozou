<script lang="ts">
  import type { Writable } from 'svelte/store';
  import { superForm } from 'sveltekit-superforms';

  import RelationSelectField from '$lib/form/widgets/relation-select-field.svelte';
  import { resolveWidget } from '$lib/form/widget-registry.js';

  let { data } = $props();

  // Derived so same-route client navigation (new data.relations) recomputes
  // the lookup instead of reusing the first load's stale relation config.
  const relationByField = $derived(
    new Map(data.relations.map((r) => [r.field, r] as const)),
  );

  // svelte-ignore state_referenced_locally
  const { form, errors, enhance, submitting } = superForm(data.form, {
    dataType: 'json',
  });

  // superforms types each field as `unknown`; a single-column FK holds a
  // scalar, so expose a scalar-typed view of the same store for the picker
  // bindings (the erased widget registry path keeps the `unknown` type).
  const relationForm = form as unknown as Writable<
    Record<string, string | number | null>
  >;
</script>

<h1 class="mb-1 text-2xl font-semibold">New {data.table.label}</h1>
<p class="mb-6 text-sm text-muted-foreground">{data.table.qualifiedName}</p>

<form method="POST" use:enhance class="space-y-4">
  {#each data.table.columns as col (col.name)}
    {@const required = !col.nullable && !col.readonly && !col.isPrimaryKey}
    {@const relation = relationByField.get(col.name)}
    <div>
      {#if col.widget === 'relation-select' && relation}
        <!-- Re-create the picker when its target config changes so a reused
             component (same-route client navigation) cannot keep searching a
             stale resource. -->
        {#key `${relation.resource}|${relation.labelField}|${relation.searchFields.join(',')}`}
          <RelationSelectField
            name={col.name}
            label={col.label}
            resource={relation.resource}
            labelField={relation.labelField}
            searchFields={relation.searchFields}
            initialOptions={data.initialOptions[col.name] ?? []}
            bind:value={$relationForm[col.name]}
            {required}
            readonly={col.readonly}
          />
        {/key}
      {:else}
        {@const Widget = resolveWidget(col.widget)}
        <Widget
          name={col.name}
          label={col.label}
          bind:value={$form[col.name]}
          options={col.enumValues}
          {required}
          readonly={col.readonly}
        />
      {/if}
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
      href={`/tables/${data.table.qualifiedName}`}
      class="rounded-md border border-border px-4 py-2 text-sm font-medium"
    >
      Cancel
    </a>
  </div>
</form>
