<script lang="ts">
  interface Props {
    name: string;
    label: string;
    value?: string | null;
    required?: boolean;
    placeholder?: string;
    readonly?: boolean;
  }

  let {
    name,
    label,
    value = $bindable(''),
    required = false,
    placeholder = '00000000-0000-0000-0000-000000000000',
    readonly = false,
  }: Props = $props();
</script>

<label class="block">
  <span class="mb-1 block text-sm font-medium">
    {label}{#if required}<span class="text-destructive" aria-hidden="true"> *</span>{/if}
  </span>
  <input
    type="text"
    {name}
    {required}
    {placeholder}
    {readonly}
    bind:value
    pattern="[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
    class="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs"
  />
</label>
