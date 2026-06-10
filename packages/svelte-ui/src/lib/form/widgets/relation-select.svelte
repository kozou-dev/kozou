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

  // Associate the visible label with the <select> (the value control) via
  // for/id. The search box is a second control under the same field, so it
  // carries its own aria-label instead of competing for the field label.
  const selectId = $derived(`relation-${name}`);

  function handleInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    query = target.value;
    onsearch?.(query);
  }
</script>

<div class="block">
  <label for={selectId} class="mb-1 block text-sm font-medium">
    {label}{#if required}<span class="text-destructive" aria-hidden="true"> *</span>{/if}
  </label>
  {#if onsearch}
    <input
      type="text"
      placeholder="Search…"
      aria-label={`Search ${label}`}
      value={query}
      oninput={handleInput}
      disabled={readonly}
      class="mb-2 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
    />
  {/if}
  <select
    id={selectId}
    {name}
    {required}
    disabled={readonly}
    bind:value
    class="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
  >
    {#if !required}
      <!-- Clearing an optional relation must submit null, not "" — the FK
           column (uuid / integer / ...) cannot store an empty string. -->
      <option value={null}>--</option>
    {/if}
    {#each options as option (option.id)}
      <option value={option.id}>{option.label}</option>
    {/each}
  </select>
</div>
