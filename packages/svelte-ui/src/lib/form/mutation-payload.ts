// Build the create / update payload sent to the DataAdapter from a
// validated superforms `form.data` object.
//
// Columns the database can supply on its own (a DEFAULT, or a read-only
// / server-generated column — see dbCanSupplyColumn) are submitted by
// the form as an empty string. Forwarding `id: ""` to the REST adapter
// makes the insert fail ("invalid input syntax for type uuid"), so those
// empty values are dropped here, letting the column's DEFAULT (e.g.
// gen_random_uuid()) take over on the server. Columns the form genuinely
// owns are passed through untouched, including explicit nulls so a
// nullable column can be cleared.
//
// See Kozou v0.1 design spec §8.3.3 (create) / §8.3.5 (update).

import type { TableContext } from '@kozou/core';

import { dbCanSupplyColumn } from './zod-from-column.js';

function isEmpty(value: unknown): boolean {
  return value === '' || value === undefined;
}

export function buildMutationPayload(
  table: TableContext,
  data: Record<string, unknown>,
): Record<string, unknown> {
  const byName = new Map(table.columns.map((c) => [c.name, c]));
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    const column = byName.get(key);
    if (column && dbCanSupplyColumn(column) && isEmpty(value)) {
      // Drop it so the database default / generated value applies.
      continue;
    }
    payload[key] = value;
  }
  return payload;
}
