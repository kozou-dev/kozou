<script lang="ts">
  interface Props {
    name: string;
    label: string;
    options: string[];
    value?: string | null;
    required?: boolean;
    readonly?: boolean;
  }

  let {
    name,
    label,
    options,
    value = $bindable(''),
    required = false,
    readonly = false,
  }: Props = $props();
</script>

<label class="block">
  <span class="mb-1 block text-sm font-medium">
    {label}{#if required}<span class="text-destructive" aria-hidden="true"> *</span>{/if}
  </span>
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
    {#each options as option (option)}
      <option value={option}>{option}</option>
    {/each}
  </select>
</label>
