<script lang="ts">
  interface Props {
    name: string;
    label: string;
    value?: string | null;
    required?: boolean;
    readonly?: boolean;
  }

  let {
    name,
    label,
    value = $bindable(''),
    required = false,
    readonly = false,
  }: Props = $props();
</script>

<label class="block">
  <span class="mb-1 block text-sm font-medium">
    {label}{#if required}<span class="text-destructive" aria-hidden="true"> *</span>{/if}
  </span>
  <input
    type="date"
    {name}
    {required}
    {readonly}
    bind:value
    class="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
  />
</label>
