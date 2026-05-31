<script lang="ts">
  import ListTable from '$lib/list/ListTable.svelte';

  let { data } = $props();
</script>

<ListTable
  title={data.table.label}
  qualifiedName={data.table.qualifiedName}
  columns={data.table.columns}
  rows={data.list.rows}
  total={data.list.total}
  listParams={data.listParams}
  basePath={`/tables/${data.table.qualifiedName}`}
  primaryKey={data.table.primaryKey}
/>
