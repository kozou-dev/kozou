<script lang="ts">
  interface Props {
    name: string;
    label: string;
    value?: boolean;
    readonly?: boolean;
  }

  let {
    name,
    label,
    value = $bindable(false),
    readonly = false,
  }: Props = $props();
</script>

<label class="flex items-center gap-2">
  <input
    type="checkbox"
    {name}
    disabled={readonly}
    bind:checked={value}
    class="h-4 w-4 rounded border border-input bg-background"
  />
  <span class="text-sm font-medium">{label}</span>
</label>
