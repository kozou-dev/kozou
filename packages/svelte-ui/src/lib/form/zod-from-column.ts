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

// True when the database can populate this column on its own, so the
// create form is allowed to leave it empty:
//   - it carries a DEFAULT (e.g. a `gen_random_uuid()` primary key or a
//     `DEFAULT 'public'` enum); or
//   - it is read-only / server-generated, so the form never collects a
//     value for it.
export function dbCanSupplyColumn(column: ColumnContext): boolean {
  return column.defaultExpr !== null || column.readonly;
}

export function zodFromColumn(column: ColumnContext): ZodTypeAny {
  const base = pickBase(column);

  // A column the database can fill on its own must not be a required
  // form field. The create form still renders an (empty / read-only)
  // input for it and submits an empty string; the create route then
  // strips empties so the DB default takes over (see mutation-payload).
  //
  // Accepting `z.literal('')` alongside the base type does two things:
  //  1. validation passes for the empty submission — without it the
  //     auto-generated uuid primary key fails with "Invalid uuid",
  //     which made it impossible to create a row in any table with a
  //     uuid-default PK (dev_spec §8.3.3);
  //  2. the schema's inferred default becomes '' (the first union
  //     member) rather than `undefined`, so the form binds a string.
  //     Binding `undefined` to the widgets — which declare
  //     `$bindable('')` — trips Svelte's `props_invalid_value` and
  //     crashes the form on client-side navigation to /new and /edit.
  if (dbCanSupplyColumn(column)) {
    const inner = column.nullable ? base.nullable() : base;
    return z.union([z.literal(''), inner]);
  }

  // Nullable (no default) columns allow null but NOT undefined, so the
  // inferred form default is `null` instead of `undefined`. Binding null
  // is fine; binding undefined trips the same `props_invalid_value`
  // crash described above.
  if (column.nullable) {
    return base.nullable();
  }

  return base;
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
