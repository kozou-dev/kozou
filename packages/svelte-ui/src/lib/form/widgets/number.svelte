<script lang="ts">
  interface Props {
    name: string;
    label: string;
    value?: number | string | null;
    required?: boolean;
    placeholder?: string;
    readonly?: boolean;
    step?: number | string;
  }

  let {
    name,
    label,
    value = $bindable(''),
    required = false,
    placeholder = '',
    readonly = false,
    step = 'any',
  }: Props = $props();
</script>

<label class="block">
  <span class="mb-1 block text-sm font-medium">
    {label}{#if required}<span class="text-destructive" aria-hidden="true"> *</span>{/if}
  </span>
  <input
    type="number"
    {name}
    {step}
    {required}
    {placeholder}
    {readonly}
    bind:value
    class="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
  />
</label>
