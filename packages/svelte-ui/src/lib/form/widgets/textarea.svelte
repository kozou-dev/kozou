<script lang="ts">
  interface Props {
    name: string;
    label: string;
    value?: string | null;
    required?: boolean;
    placeholder?: string;
    readonly?: boolean;
    rows?: number;
  }

  let {
    name,
    label,
    value = $bindable(''),
    required = false,
    placeholder = '',
    readonly = false,
    rows = 4,
  }: Props = $props();
</script>

<label class="block">
  <span class="mb-1 block text-sm font-medium">
    {label}{#if required}<span class="text-destructive" aria-hidden="true"> *</span>{/if}
  </span>
  <textarea
    {name}
    {rows}
    {required}
    {placeholder}
    {readonly}
    bind:value
    class="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
  ></textarea>
</label>
