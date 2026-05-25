<script lang="ts">
  interface Props {
    name: string;
    label: string;
    value?: unknown;
    required?: boolean;
    readonly?: boolean;
  }

  let {
    name,
    label,
    value = $bindable(undefined),
    required = false,
    readonly = false,
  }: Props = $props();

  function formatInitial(input: unknown): string {
    if (input === undefined || input === null) return '';
    if (typeof input === 'string') return input;
    try {
      return JSON.stringify(input, null, 2);
    } catch {
      return '';
    }
  }

  let text = $state(formatInitial(value));

  function handleInput(event: Event): void {
    const target = event.target as HTMLTextAreaElement;
    text = target.value;
    try {
      value = text.length === 0 ? undefined : JSON.parse(text);
    } catch {
      value = text;
    }
  }
</script>

<label class="block">
  <span class="mb-1 block text-sm font-medium">
    {label}{#if required}<span class="text-destructive" aria-hidden="true"> *</span>{/if}
  </span>
  <textarea
    {name}
    {required}
    {readonly}
    rows={6}
    value={text}
    oninput={handleInput}
    class="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs"
  ></textarea>
</label>
