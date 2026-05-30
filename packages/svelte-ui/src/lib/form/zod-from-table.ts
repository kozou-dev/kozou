// Build a zod object schema for every column of a TableContext.
// new/edit routes (Sub-step 6-J) feed the result into sveltekit-
// superforms to validate Create / Update payloads.

import { z } from 'zod';

import type { TableContext } from '@kozou/core';

import { zodFromColumn } from './zod-from-column.js';

export function zodFromTable(table: TableContext) {
  // zod 4's ZodRawShape is read-only, so accumulate the per-column schemas
  // into a plain mutable record and let z.object infer the result type.
  const shape: Record<string, ReturnType<typeof zodFromColumn>> = {};
  for (const column of table.columns) {
    shape[column.name] = zodFromColumn(column);
  }
  return z.object(shape);
}
