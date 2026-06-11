// Regression for the relation-select form schema + superforms.
//
// A single-column foreign key renders as `relation-select`, whose zod schema
// is a multi-type union (string | number). The superforms zod adapter rejects
// a union with no default ("Multi-type unions must have a default value, or
// exactly one of the union types must have"), which made `superValidate` throw
// while building the create/edit form for any table with an FK column — so the
// page never rendered. The empty-string literal member supplies the default.
//
// This exercises the real superValidate path (no database needed), reproducing
// what the Playwright suite hit when it first rendered a form with an FK.

import { describe, expect, it } from 'vitest';

import { superValidate } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';

import type { ColumnContext, TableContext, WidgetType } from '@kozou/core';

import { zodFromTable } from '../../src/lib/form/zod-from-table.js';

function makeColumn(overrides: Partial<ColumnContext>): ColumnContext {
  return {
    name: 'col',
    dataType: 'text',
    nullable: false,
    defaultExpr: null,
    isPrimaryKey: false,
    isForeignKey: false,
    label: 'Col',
    description: null,
    aiDescription: null,
    widget: 'text' as WidgetType,
    enumValues: null,
    readonly: false,
    ...overrides,
  };
}

function makeTable(columns: ColumnContext[]): TableContext {
  return {
    schema: 'public',
    name: 'books',
    qualifiedName: 'public.books',
    label: 'Books',
    description: null,
    aiDescription: null,
    primaryKey: ['id'],
    displayField: 'title',
    columns,
    relations: [],
    rawTable: {} as TableContext['rawTable'],
  };
}

describe('superValidate over a relation-select form schema', () => {
  it('initializes a NOT NULL relation-select field without throwing', async () => {
    const table = makeTable([
      makeColumn({
        name: 'id',
        widget: 'uuid',
        defaultExpr: 'gen_random_uuid()',
      }),
      makeColumn({
        name: 'author_id',
        widget: 'relation-select',
        dataType: 'uuid',
        nullable: false,
        isForeignKey: true,
      }),
      makeColumn({ name: 'title', widget: 'text', nullable: false }),
    ]);

    const form = await superValidate(zod4(zodFromTable(table)));
    expect(form.data.author_id).toBe('');
  });

  it('initializes a nullable relation-select field without throwing', async () => {
    const table = makeTable([
      makeColumn({
        name: 'id',
        widget: 'uuid',
        defaultExpr: 'gen_random_uuid()',
      }),
      makeColumn({
        name: 'parent_id',
        widget: 'relation-select',
        dataType: 'uuid',
        nullable: true,
        isForeignKey: true,
      }),
    ]);

    const form = await superValidate(zod4(zodFromTable(table)));
    expect(form.data.parent_id).toBe('');
  });
});

describe('superValidate over DB-suppliable non-text columns', () => {
  // The db-supplied union (literal('') | base) needs an EXPLICIT default:
  // superforms only infers one when the union members share a base type, so
  // a defaulted enum / number / datetime column made superValidate throw
  // while building the form — a 500 on /new and /edit for any table with a
  // defaulted non-text column (surfaced by the issue #95 e2e).
  it('initializes defaulted enum / number / datetime columns without throwing', async () => {
    const table = makeTable([
      makeColumn({
        name: 'id',
        widget: 'uuid',
        dataType: 'uuid',
        defaultExpr: 'gen_random_uuid()',
      }),
      makeColumn({
        name: 'visibility',
        widget: 'enum-select',
        enumValues: ['public', 'private'],
        defaultExpr: "'public'::text",
      }),
      makeColumn({
        name: 'qty',
        widget: 'number',
        dataType: 'integer',
        defaultExpr: '1',
      }),
      makeColumn({
        name: 'created_at',
        widget: 'datetime',
        dataType: 'timestamptz',
        defaultExpr: 'now()',
      }),
    ]);

    const form = await superValidate(zod4(zodFromTable(table)));
    expect(form.data.visibility).toBe('');
    expect(form.data.qty).toBe('');
    expect(form.data.created_at).toBe('');

    // The empty submission still validates (the payload drops the empties
    // so the database defaults apply).
    const submitted = await superValidate(
      { id: '', visibility: '', qty: '', created_at: '' },
      zod4(zodFromTable(table)),
    );
    expect(submitted.valid).toBe(true);
  });
});
