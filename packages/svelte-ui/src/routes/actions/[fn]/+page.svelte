<script lang="ts">
  import type { Writable } from 'svelte/store';
  import { superForm } from 'sveltekit-superforms';

  import RelationSelectField from '$lib/form/widgets/relation-select-field.svelte';
  import { resolveWidget } from '$lib/form/widget-registry.js';

  // `form` is the latest action result (SvelteKit injects it; superForm's
  // applyAction keeps it in sync on the enhanced path too).
  let { data, form: actionData } = $props();

  // Single-column relation-select configs, keyed by argument name.
  const relationByField = $derived(
    new Map(data.relations.map((r) => [r.field, r] as const)),
  );

  // svelte-ignore state_referenced_locally
  const { form, errors, enhance, submitting } = superForm(data.form, {
    dataType: 'json',
  });

  // A relation-select argument holds a scalar id; expose a scalar-typed view of
  // the form store for the picker binding (the widget registry path is erased).
  const relationForm = form as unknown as Writable<
    Record<string, string | number | null>
  >;

  // The action returns one of two shapes (success / fail); narrow with `in`
  // so the template reads each branch's fields safely.
  const rpcOk = $derived(actionData !== null && actionData !== undefined && 'rpcOk' in actionData);
  const rpcError = $derived(
    actionData && 'rpcError' in actionData ? (actionData.rpcError as string) : null,
  );
  // Pretty-print the result; null (a void return) shows a "no result" note.
  const resultText = $derived.by(() => {
    if (actionData === null || actionData === undefined || !('rpcResult' in actionData)) {
      return null;
    }
    return actionData.rpcResult === null
      ? null
      : JSON.stringify(actionData.rpcResult, null, 2);
  });
</script>

<h1 class="mb-1 text-2xl font-semibold">{data.action.label}</h1>
<p class="mb-2 text-sm text-muted-foreground">{data.action.qualifiedName}</p>

<div class="mb-6 flex flex-wrap gap-2 text-xs">
  <span class="rounded-full border border-border px-2 py-0.5 text-muted-foreground">
    {data.action.security === 'definer' ? 'security definer' : 'security invoker'}
  </span>
  <span class="rounded-full border border-border px-2 py-0.5 text-muted-foreground">
    {data.action.volatility}
  </span>
</div>

{#if data.action.description}
  <p class="mb-4 whitespace-pre-line text-sm">{data.action.description}</p>
{/if}
{#if data.action.aiDescription}
  <div class="mb-4 rounded-md border border-border bg-muted/40 p-3 text-sm">
    <div class="mb-1 font-medium">AI notes</div>
    <p class="whitespace-pre-line text-muted-foreground">{data.action.aiDescription}</p>
  </div>
{/if}
{#if data.action.policy.length > 0}
  <div class="mb-4 rounded-md border border-border bg-muted/40 p-3 text-sm">
    <div class="mb-1 font-medium">Policy</div>
    <ul class="list-disc pl-5 text-muted-foreground">
      {#each data.action.policy as rule (rule)}
        <li>{rule}</li>
      {/each}
    </ul>
  </div>
{/if}

{#if rpcError}
  <p class="mb-4 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
    {rpcError}
  </p>
{/if}
{#if rpcOk}
  <div class="mb-4 rounded-md border border-border bg-muted/40 p-3">
    <div class="mb-1 text-sm font-medium">Result</div>
    {#if resultText === null}
      <p class="text-sm text-muted-foreground">No result (the action returned void).</p>
    {:else}
      <pre class="overflow-x-auto text-sm"><code>{resultText}</code></pre>
    {/if}
  </div>
{/if}

<form method="POST" use:enhance class="space-y-4">
  {#each data.action.args as arg (arg.name)}
    {@const relation = relationByField.get(arg.name)}
    <div>
      {#if arg.widget === 'relation-select' && relation}
        {#key `${relation.resource}|${relation.labelField}|${relation.searchFields.join(',')}`}
          <RelationSelectField
            name={arg.name}
            label={arg.label}
            resource={relation.resource}
            labelField={relation.labelField}
            searchFields={relation.searchFields}
            initialOptions={data.initialOptions[arg.name] ?? []}
            bind:value={$relationForm[arg.name]}
            required={arg.required}
            readonly={false}
          />
        {/key}
      {:else}
        {@const Widget = resolveWidget(arg.widget)}
        <Widget
          name={arg.name}
          label={arg.label}
          bind:value={$form[arg.name]}
          options={arg.enumValues}
          required={arg.required}
          readonly={false}
        />
      {/if}
      {#if $errors[arg.name]}
        <p class="mt-1 text-sm text-destructive">{$errors[arg.name]}</p>
      {/if}
    </div>
  {/each}

  <div class="flex gap-3">
    <button
      type="submit"
      disabled={$submitting}
      class="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
    >
      {$submitting ? 'Running…' : 'Run action'}
    </button>
    <a href="/" class="rounded-md border border-border px-4 py-2 text-sm font-medium">
      Cancel
    </a>
  </div>
</form>
