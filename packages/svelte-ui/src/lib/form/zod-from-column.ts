// Build a zod schema for a single ColumnContext.
//
// Keeps the conversion in a pure module so the form generators
// (Sub-step 6-J onwards) can compose tables -> zod -> superforms
// without coupling the .svelte template to zod's API. dataType +
// widget + nullable + enumValues are the inputs; CHECK constraints
// beyond enum extraction are out of scope for v0.1.

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
  // A relation-select holds a scalar foreign-key id (string | number) or the
  // empty "unselected" state. Accept '' via a literal union member so
  // superforms can infer a default for the otherwise multi-type union — a bare
  // `string | number` union has no default and `superValidate` throws
  // ("Multi-type unions must have a default value ..."). A nullable foreign key
  // also accepts null. An empty submission is turned into null (or dropped for
  // a DB-supplied column) by buildMutationPayload.
  if (column.widget === 'relation-select') {
    // The FK id is string | number — a genuine multi-type union, which the
    // superforms zod adapter rejects unless it carries an explicit default
    // ("Multi-type unions must have a default value ..."), so default to '',
    // the unselected state. `.default('')` only fills an absent field on form
    // init; a submitted value is still validated.
    //
    // A required FK (NOT NULL, no DB default) must reject the empty selection:
    // buildMutationPayload turns a relation-select '' into null, which a NOT
    // NULL column would refuse at the database with an opaque error, so the
    // string member requires a non-empty id and the empty submission fails
    // form validation instead. A nullable FK accepts '' (cleared to null) and
    // null; a DB-supplied FK accepts '' (dropped so the default applies).
    const required = !column.nullable && !dbCanSupplyColumn(column);
    const id = z.union([required ? z.string().min(1) : z.string(), z.number()]);
    return (column.nullable ? id.nullable() : id).default('');
  }

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
  //     uuid-default PK;
  //  2. the schema's inferred default becomes '' (the first union
  //     member) rather than `undefined`, so the form binds a string.
  //     Binding `undefined` to the widgets — which declare
  //     `$bindable('')` — trips Svelte's `props_invalid_value` and
  //     crashes the form on client-side navigation to /new and /edit.
  if (dbCanSupplyColumn(column)) {
    const inner = column.nullable ? base.nullable() : base;
    // The default must be EXPLICIT: superforms infers a default from a union
    // only when its members share one base type, so `literal('') | string`
    // worked but `literal('') | enum / number / date` threw "Multi-type
    // unions must have a default value" while building the form — a 500 on
    // /new and /edit for ANY table with a defaulted non-text column. Same
    // medicine as the relation-select branch above.
    return z.union([z.literal(''), inner]).default('');
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
    case 'uuid':
      // PostgreSQL's `uuid` type accepts any 8-4-4-4-12 hex string and does
      // not enforce the RFC version/variant bits. zod 4's `z.uuid()` does
      // enforce them (rejecting otherwise-valid stored values), so use the
      // format-only `z.guid()` to mirror what the database will accept.
      return z.guid();
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
