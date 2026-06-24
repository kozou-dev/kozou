<script lang="ts">
  import type { Writable } from 'svelte/store';
  import { superForm } from 'sveltekit-superforms';

  import type { RelationFieldConfig } from '$lib/form/relation-field-config.js';
  import RelationSelectCompositeField from '$lib/form/widgets/relation-select-composite-field.svelte';
  import RelationSelectField from '$lib/form/widgets/relation-select-field.svelte';
  import { resolveWidget } from '$lib/form/widget-registry.js';

  let { data } = $props();

  // Derived so same-route client navigation (new data.relations) recomputes
  // the lookup instead of reusing the first load's stale relation config.
  const relationByField = $derived(
    new Map(
      data.relations
        .filter((r) => (r.fields ?? [r.field]).length === 1)
        .map((r) => [r.field, r] as const),
    ),
  );

  // A composite relation renders ONE picker — at the group's first column in
  // table order — and suppresses the remaining component columns (the picker
  // writes every component through the form store).
  const compositeLayout = $derived.by(() => {
    const hostByField = new Map<string, RelationFieldConfig>();
    const memberFields = new Set<string>();
    for (const config of data.relations) {
      const fields = config.fields ?? [config.field];
      if (fields.length < 2) continue;
      const grouped = new Set(fields);
      const ordered = data.table.columns
        .filter((c) => grouped.has(c.name))
        .map((c) => c.name);
      if (ordered.length !== fields.length) continue;
      hostByField.set(ordered[0], config);
      for (const field of ordered.slice(1)) memberFields.add(field);
    }
    return { hostByField, memberFields };
  });

  // svelte-ignore state_referenced_locally
  const { form, errors, enhance, submitting, message } = superForm(data.form, {
    dataType: 'json',
  });

  // superforms types each field as `unknown`; a single-column FK holds a
  // scalar, so expose a scalar-typed view of the same store for the picker
  // bindings (the erased widget registry path keeps the `unknown` type).
  const relationForm = form as unknown as Writable<
    Record<string, string | number | null>
  >;

  function memberColumns(config: RelationFieldConfig) {
    const grouped = new Set(config.fields ?? [config.field]);
    return data.table.columns.filter((c) => grouped.has(c.name));
  }

  // Write a picked option's components into every foreign-key column of the
  // group, in key order. A clear writes the relation-select '' sentinel —
  // the same value the native path's deleted fields default to — so
  // buildMutationPayload treats both paths identically (null for a plain
  // nullable column, dropped for a DB-supplied one).
  function applyComposite(
    config: RelationFieldConfig,
    components: Array<string | number> | null,
  ): void {
    const keyFields = config.keyFields ?? [config.field];
    relationForm.update((current) => {
      const next = { ...current };
      keyFields.forEach((field, i) => {
        next[field] = components === null ? '' : components[i];
      });
      return next;
    });
  }
</script>

<a
  href={`/tables/${data.table.qualifiedName}`}
  class="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
>
  <span aria-hidden="true">←</span> {data.table.label}
</a>

<h1 class="mb-1 text-2xl font-semibold">Edit {data.table.label}</h1>
<p class="mb-6 text-sm text-muted-foreground">
  {data.table.qualifiedName} / {data.id}
</p>

<form method="POST" use:enhance class="space-y-4">
  {#if $message}
    <p
      role="alert"
      class="rounded-md border border-destructive bg-destructive/10 px-3 py-2 text-sm text-destructive"
    >
      {$message}
    </p>
  {/if}
  {#each data.table.columns as col (col.name)}
    <!-- Unlike the create form, a defaulted NOT NULL column stays REQUIRED
         on edit: an UPDATE cannot express "reset to DEFAULT", so an empty
         value would be dropped and the old value silently kept — offering a
         clear that does nothing. The create-only relaxation is #95. -->
    {@const required = !col.nullable && !col.readonly && !col.isPrimaryKey}
    {@const relation = relationByField.get(col.name)}
    {@const composite = compositeLayout.hostByField.get(col.name)}
    <div>
      {#if compositeLayout.memberFields.has(col.name)}
        <!-- Written by the composite picker rendered at the group's first
             column; no input of its own. -->
      {:else if composite}
        {@const members = memberColumns(composite)}
        <!-- Deliberately ignores dbCanSupply: clearing a composite picker
             empties EVERY component, which is only valid when all of them
             are nullable — a defaulted NOT NULL component cannot be nulled,
             so the group keeps its required marker (no clear option). -->
        {@const groupRequired = members.some(
          (c) => !c.nullable && !c.readonly && !c.isPrimaryKey,
        )}
        {@const groupReadonly = members.some((c) => c.readonly)}
        <!-- Re-create the picker when its target config or the edited record
             changes so a reused component (same-route client navigation)
             cannot keep stale options / search a stale resource. -->
        {#key `${composite.resource}|${composite.labelField}|${composite.searchFields.join(',')}|${data.id}`}
          <RelationSelectCompositeField
            name={composite.field}
            label={members.map((c) => c.label).join(', ')}
            resource={composite.resource}
            labelField={composite.labelField}
            searchFields={composite.searchFields}
            initialOptions={data.initialOptions[composite.field] ?? []}
            values={(composite.keyFields ?? [composite.field]).map(
              (field) => $relationForm[field],
            )}
            onpick={(components) => applyComposite(composite, components)}
            required={groupRequired}
            readonly={groupReadonly}
          />
        {/key}
        <!-- Server-rendered baseline: a native (no-JS) submission must keep
             the current component values on an untouched save — the member
             inputs are suppressed and a disabled (readonly) select submits
             nothing. A pick or an explicit clear overrides these
             server-side; the enhanced path ignores DOM fields entirely. -->
        {#each members as member (member.name)}
          <input
            type="hidden"
            name={member.name}
            value={$relationForm[member.name] === null ||
            $relationForm[member.name] === undefined
              ? ''
              : String($relationForm[member.name])}
          />
        {/each}
        {#each members as member (member.name)}
          {#if $errors[member.name]}
            <p class="mt-1 text-sm text-destructive">
              {member.label}: {$errors[member.name]}
            </p>
          {/if}
        {/each}
      {:else if col.widget === 'relation-select' && relation}
        <!-- Re-create the picker when its target config or the edited record
             changes so a reused component (same-route client navigation)
             cannot keep stale options / search a stale resource. -->
        {#key `${relation.resource}|${relation.labelField}|${relation.searchFields.join(',')}|${data.id}`}
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
      {#if !composite && !compositeLayout.memberFields.has(col.name) && $errors[col.name]}
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
