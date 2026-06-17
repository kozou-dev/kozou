import type { SchemaContext } from '@kozou/core';
import {
  listTablesInputSchema,
  type ListTablesInput,
  type ListTablesOutput,
} from '../schemas/list_tables.js';

export function listTables(input: ListTablesInput, ctx: SchemaContext): ListTablesOutput {
  const parsed = listTablesInputSchema.parse(input);
  const schema = parsed.schema ?? 'public';
  // `sourceSchemas` is the configured source schema set (what introspection was
  // pointed at). `outOfScope` true => the requested schema is not in that set,
  // so an empty `tables` means "not looking there" rather than "nothing here".
  // (A schema configured but absent from the database is still reported in the
  // set — introspection warns and skips it — so it reads as in-scope-empty.)
  const sourceSchemas = ctx.meta.sourceSchemas;
  return {
    sourceSchemas,
    outOfScope: !sourceSchemas.includes(schema),
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
