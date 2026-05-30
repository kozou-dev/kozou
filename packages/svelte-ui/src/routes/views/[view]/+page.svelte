<script lang="ts">
  import ListTable from '$lib/list/ListTable.svelte';

  let { data } = $props();
</script>

<ListTable
  title={data.view.label}
  qualifiedName={data.view.qualifiedName}
  columns={data.view.columns}
  rows={data.list.rows}
  total={data.list.total}
  listParams={data.listParams}
  readonly
/>
