import type { SchemaContext } from '@kozou/core';
import {
  listTablesInputSchema,
  type ListTablesInput,
  type ListTablesOutput,
} from '../schemas/list_tables.js';

export function listTables(input: ListTablesInput, ctx: SchemaContext): ListTablesOutput {
  const parsed = listTablesInputSchema.parse(input);
  const schema = parsed.schema ?? 'public';
  return {
    tables: ctx.tables
      .filter((t) => t.schema === schema)
      .map((t) => ({
        qualifiedName: t.qualifiedName,
        label: t.label,
        description: t.description,
        // Planner estimate threaded through introspect ->
        // RawTable.rowCountEstimate. `null` when PostgreSQL has not
        // analyzed the table yet.
        rowCountEstimate: t.rawTable.rowCountEstimate,
      })),
  };
}
