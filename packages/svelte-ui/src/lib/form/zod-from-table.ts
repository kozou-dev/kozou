// Build a zod object schema for every column of a TableContext.
// new/edit routes (Sub-step 6-J) feed the result into sveltekit-
// superforms to validate Create / Update payloads.

import { z } from 'zod';
import type { ZodObject, ZodRawShape } from 'zod';

import type { TableContext } from '@kozou/core';

import { zodFromColumn } from './zod-from-column.js';

export function zodFromTable(table: TableContext): ZodObject<ZodRawShape> {
  const shape: ZodRawShape = {};
  for (const column of table.columns) {
    shape[column.name] = zodFromColumn(column);
  }
  return z.object(shape);
}
