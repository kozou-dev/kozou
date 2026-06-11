<script lang="ts">
  import type { RelationOption } from '@kozou/core';

  import {
    COMPOSITE_CLEAR_VALUE,
    compositeParamName,
    isPickableOption,
  } from '$lib/form/relation-field-config.js';
  import { fetchRelationOptions } from '$lib/form/relation-options-client.js';
  import { createRelationSearch } from '$lib/form/relation-search.js';
  import { encodeResourceId } from '$lib/resource-id.js';

  // One picker for a composite (multi-column) foreign key: a single select
  // whose options are target rows, writing every key component at once.
  //
  // The select's DOM value is the canonical encoded id (each component
  // percent-encoded, comma-joined) rather than the raw id array — DOM values
  // are strings, and an array would otherwise be compared by identity, so a
  // re-fetched equal id would deselect the current row. Picks write the
  // *typed* components remembered from the option (not the string form), so
  // the per-column zod schemas keep validating the same shapes the scalar
  // inputs produce.

  interface Props {
    /** Base for the select's DOM id (the relation's first column). */
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
    /** Current component values, in the target's primary-key declaration
     *  order (the order option-id components use). */
    values: Array<string | number | null | undefined>;
    /** Receives the picked option's components (same order), or `null` when
     *  the operator clears an optional relation. */
    onpick: (components: Array<string | number> | null) => void;
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
    values,
    onpick,
    required = false,
    readonly = false,
    limit = 20,
  }: Props = $props();

  type KnownOption = { label: string; components: Array<string | number> };

  // The picker config and the seed options are fixed for a field's lifetime
  // (the parent re-creates the component when the config changes), so
  // capturing their initial values here is intentional. A key containing an
  // empty-string component cannot round-trip through the '' unselected
  // sentinel, so such options are never offered (isPickableOption).
  // svelte-ignore state_referenced_locally
  let options = $state<RelationOption[]>(initialOptions.filter(isPickableOption));
  let query = $state('');

  // Remember every option seen — keyed by the canonical encoded id — so the
  // currently-selected row stays selectable after a narrowing search, and so
  // a pick writes back the typed components rather than their string forms.
  const known = new Map<string, KnownOption>();
  function remember(option: RelationOption): void {
    const components = Array.isArray(option.id) ? option.id : [option.id];
    known.set(encodeResourceId(option.id), { label: option.label, components });
  }
  // svelte-ignore state_referenced_locally
  for (const option of initialOptions.filter(isPickableOption)) remember(option);

  // '' = unselected; any missing component leaves the group unselected (a
  // partially-null composite foreign key is not a reference, and an
  // untouched native save must keep it — see the baseline fields the parent
  // renders). The all-'' state is the cleared / untouched-empty form state
  // and selects the explicit clear option when one exists. A lone empty
  // string is otherwise NOT missing — a text key component can legally be
  // '' — so only null / undefined (and non-scalars) unselect.
  const selectedKey = $derived.by(() => {
    if (values.length > 0 && values.every((value) => value === '')) {
      return COMPOSITE_CLEAR_VALUE;
    }
    const components: Array<string | number> = [];
    for (const value of values) {
      if (value === null || value === undefined) return '';
      if (typeof value !== 'string' && typeof value !== 'number') return '';
      components.push(value);
    }
    return encodeResourceId(components);
  });

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
    if (selectedKey === '' || selectedKey === COMPOSITE_CLEAR_VALUE) {
      return results;
    }
    if (results.some((option) => encodeResourceId(option.id) === selectedKey)) {
      return results;
    }
    const current = known.get(selectedKey);
    if (current === undefined) return results;
    return [{ id: current.components, label: current.label }, ...results];
  }

  async function handleSearchInput(event: Event): Promise<void> {
    query = (event.target as HTMLInputElement).value;
    try {
      const results = (await search.search(query)).filter(isPickableOption);
      for (const option of results) remember(option);
      options = withSelected(results);
    } catch {
      // A superseded search rejects (RelationSearchCancelledError); a network
      // error rejects too. Either way keep the prior options in place.
    }
  }

  function handleChange(event: Event): void {
    const key = (event.target as HTMLSelectElement).value;
    if (key === COMPOSITE_CLEAR_VALUE) {
      // Explicit clear of an optional relation (the parent writes the ''
      // sentinel into every component; buildMutationPayload turns it into
      // null — the foreign-key columns cannot store an empty string).
      onpick(null);
      return;
    }
    if (key === '') return; // the disabled placeholder is not a pick
    const picked = known.get(key);
    if (picked !== undefined) onpick(picked.components);
  }

  const selectId = $derived(`relation-${name}`);
</script>

<div class="block">
  <label for={selectId} class="mb-1 block text-sm font-medium">
    {label}{#if required}<span class="text-destructive" aria-hidden="true"> *</span>{/if}
  </label>
  <input
    type="text"
    placeholder="Search…"
    aria-label={`Search ${label}`}
    value={query}
    oninput={handleSearchInput}
    disabled={readonly}
    class="mb-2 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
  />
  <!-- The select is the ONLY submitted control: a native (non-enhanced)
       POST carries the picked row's canonical encoded id under the
       synthetic name, and the server decodes it into the component fields
       ahead of validation (readFormWithCompositePicks). The enhanced
       (dataType: 'json') path submits the form store instead — the picker
       writes components into it via onpick — and ignores this field. -->
  <select
    id={selectId}
    name={compositeParamName(name)}
    {required}
    disabled={readonly}
    value={selectedKey}
    onchange={handleChange}
    class="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
  >
    <!-- Always-rendered disabled placeholder = the preserve-baseline state.
         It is selected whenever nothing (or a partial value) is selected, so
         a native (no-JS) submission carries '' — keep the baselines — rather
         than the browser auto-picking the first enabled option. On a
         required picker the `required` constraint additionally blocks the
         empty value until the operator actually picks. -->
    <option value="" disabled>Select…</option>
    {#if !required}
      <!-- The explicit clear marker: '' cannot mean "clear" natively, since
           an unselected (e.g. partial-null) current value renders '' too and
           an untouched no-JS save must keep the baseline values. -->
      <option value={COMPOSITE_CLEAR_VALUE}>--</option>
    {/if}
    {#each options as option (encodeResourceId(option.id))}
      <option value={encodeResourceId(option.id)}>{option.label}</option>
    {/each}
  </select>
</div>
