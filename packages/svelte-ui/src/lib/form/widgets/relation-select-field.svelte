<script lang="ts">
  import type { RelationOption } from '@kozou/core';

  import { fetchRelationOptions } from '$lib/form/relation-options-client.js';
  import { createRelationSearch } from '$lib/form/relation-search.js';
  import { encodeResourceId } from '$lib/resource-id.js';

  import RelationSelect from './relation-select.svelte';

  interface Props {
    name: string;
    label: string;
    /** "schema.table" the picker searches. */
    resource: string;
    /** Target column shown as each option's label. */
    labelField: string;
    /** Target columns the substring search filters on. */
    searchFields: string[];
    /** Server-rendered first page (plus the current value on edit) so the
     *  picker has rows before the browser issues any request. */
    initialOptions: RelationOption[];
    value?: string | number | null;
    required?: boolean;
    readonly?: boolean;
    limit?: number;
  }

  let {
    name,
    label,
    resource,
    labelField,
    searchFields,
    initialOptions,
    value = $bindable(''),
    required = false,
    readonly = false,
    limit = 20,
  }: Props = $props();

  // The picker config (resource / label / search fields) and the seed
  // options are fixed for a field's lifetime, so capturing their initial
  // values here is intentional.
  // svelte-ignore state_referenced_locally
  let options = $state<RelationOption[]>([...initialOptions]);

  // Remember every label seen so the currently-selected row stays in the
  // dropdown even after a search narrows the results to rows that exclude it
  // — otherwise saving an unchanged record could drop its foreign key. Keys
  // are the canonical encoded id, so a scalar and a composite array id both
  // key consistently.
  const known = new Map<string, string>();
  // svelte-ignore state_referenced_locally
  for (const option of initialOptions) known.set(encodeResourceId(option.id), option.label);

  // svelte-ignore state_referenced_locally
  const search = createRelationSearch({
    adapter: {
      searchRelation: (target, params) =>
        fetchRelationOptions((url) => fetch(url), target, params),
    },
    resource,
    labelField,
    searchFields,
    limit,
  });

  function withSelected(results: RelationOption[]): RelationOption[] {
    if (value === '' || value === null || value === undefined) return results;
    const selected = value as string | number;
    const selectedKey = encodeResourceId(selected);
    if (results.some((option) => encodeResourceId(option.id) === selectedKey)) return results;
    const selectedLabel = known.get(selectedKey);
    if (selectedLabel === undefined) return results;
    return [{ id: selected, label: selectedLabel }, ...results];
  }

  async function handleSearch(query: string): Promise<void> {
    try {
      const results = await search.search(query);
      for (const option of results) known.set(encodeResourceId(option.id), option.label);
      options = withSelected(results);
    } catch {
      // A superseded search rejects (RelationSearchCancelledError); a network
      // error rejects too. Either way keep the prior options in place.
    }
  }
</script>

<RelationSelect
  {name}
  {label}
  {options}
  {required}
  {readonly}
  bind:value
  onsearch={handleSearch}
/>
