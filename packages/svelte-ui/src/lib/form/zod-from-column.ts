// Build a zod schema for a single ColumnContext.
//
// Keeps the conversion in a pure module so the form generators
// (Sub-step 6-J onwards) can compose tables -> zod -> superforms
// without coupling the .svelte template to zod's API. dataType +
// widget + nullable + enumValues are the inputs; CHECK constraints
// beyond enum extraction are out of scope for v0.1 (see Kozou v0.1
// design spec §6.4 / §6.5 / §8.3.3).

import { z } from 'zod';
import type { ZodTypeAny } from 'zod';

import type { ColumnContext } from '@kozou/core';

export function zodFromColumn(column: ColumnContext): ZodTypeAny {
  let schema: ZodTypeAny = pickBase(column);

  if (column.nullable) {
    schema = schema.nullable().optional();
  }

  return schema;
}

function pickBase(column: ColumnContext): ZodTypeAny {
  switch (column.widget) {
    case 'number':
    case 'currency':
      return z.coerce.number();
    case 'boolean':
      return z.coerce.boolean();
    case 'date':
    case 'datetime':
      return z.coerce.date();
    case 'enum-select':
      if (column.enumValues && column.enumValues.length > 0) {
        return z.enum(column.enumValues as [string, ...string[]]);
      }
      return z.string();
    case 'relation-select':
      return z.union([z.string(), z.number()]);
    case 'uuid':
      return z.string().uuid();
    case 'json':
      return z.unknown();
    case 'image-url':
    case 'text':
    case 'textarea':
      return z.string();
    default:
      return z.string();
  }
}
