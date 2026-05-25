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
    placeholder = 'https://…',
    readonly = false,
  }: Props = $props();
</script>

<label class="block">
  <span class="mb-1 block text-sm font-medium">
    {label}{#if required}<span class="text-destructive" aria-hidden="true"> *</span>{/if}
  </span>
  <input
    type="url"
    {name}
    {required}
    {placeholder}
    {readonly}
    bind:value
    class="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
  />
  {#if value}
    <img
      src={value}
      alt={label}
      class="mt-2 max-h-32 rounded-md border border-border object-contain"
      loading="lazy"
    />
  {/if}
</label>
