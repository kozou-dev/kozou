<script lang="ts">
  import type { RelationOption } from '@kozou/core';

  interface Props {
    name: string;
    label: string;
    options: RelationOption[];
    value?: string | number | null;
    required?: boolean;
    readonly?: boolean;
    onsearch?: (query: string) => void;
  }

  let {
    name,
    label,
    options,
    value = $bindable(''),
    required = false,
    readonly = false,
    onsearch,
  }: Props = $props();

  let query = $state('');

  function handleInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    query = target.value;
    onsearch?.(query);
  }
</script>

<label class="block">
  <span class="mb-1 block text-sm font-medium">
    {label}{#if required}<span class="text-destructive" aria-hidden="true"> *</span>{/if}
  </span>
  <input
    type="text"
    placeholder="Search…"
    value={query}
    oninput={handleInput}
    disabled={readonly}
    class="mb-2 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
  />
  <select
    {name}
    {required}
    disabled={readonly}
    bind:value
    class="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
  >
    {#if !required}
      <option value="">--</option>
    {/if}
    {#each options as option (option.id)}
      <option value={option.id}>{option.label}</option>
    {/each}
  </select>
</label>
