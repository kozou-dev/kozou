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
