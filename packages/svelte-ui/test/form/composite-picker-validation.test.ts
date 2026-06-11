// Regression for the composite-picker form schema + superforms.
//
// The composite picker suppresses its component columns, so the operator
// never sees their inputs. With plain scalar widgets, superforms initializes
// an absent required NUMERIC component to 0 — an invisible, fabricated
// `(0, 0)` reference that an untouched create form would silently submit.
// promoteCompositeMemberWidgets switches the component columns to the
// relation-select widget contract: the unselected default is '' and a
// required component rejects an empty submission, so an untouched required
// composite pick fails validation instead of writing a fabricated key.
//
// This exercises the real superValidate path (no database needed).

import { describe, expect, it } from 'vitest';

import { superValidate } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';

import type { ColumnContext, TableContext, WidgetType } from '@kozou/core';

import {
  demoteUnpickableRelations,
  promoteCompositeMemberWidgets,
  type RelationFieldConfig,
} from '../../src/lib/form/relation-field-config.js';
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

const binRelation: RelationFieldConfig = {
  field: 'aisle',
  fields: ['aisle', 'shelf'],
  keyFields: ['aisle', 'shelf'],
  resource: 'public.warehouse_bins',
  labelField: 'name',
  searchFields: ['name'],
};

function assignmentsTable(memberNullable: boolean): TableContext {
  return {
    schema: 'public',
    name: 'bin_assignments',
    qualifiedName: 'public.bin_assignments',
    label: 'Bin Assignments',
    description: null,
    aiDescription: null,
    primaryKey: ['id'],
    displayField: null,
    columns: [
      makeColumn({
        name: 'id',
        dataType: 'uuid',
        widget: 'uuid',
        isPrimaryKey: true,
        defaultExpr: 'gen_random_uuid()',
      }),
      makeColumn({
        name: 'aisle',
        dataType: 'integer',
        widget: 'number',
        nullable: memberNullable,
        isForeignKey: true,
      }),
      makeColumn({
        name: 'shelf',
        dataType: 'integer',
        widget: 'number',
        nullable: memberNullable,
        isForeignKey: true,
      }),
      makeColumn({ name: 'note', nullable: true, widget: 'text' }),
    ],
    relations: [
      {
        field: 'aisle',
        fields: ['aisle', 'shelf'],
        references: {
          schema: 'public',
          table: 'warehouse_bins',
          column: 'aisle',
          columns: ['aisle', 'shelf'],
        },
        cardinality: 'many-to-one',
        meaning: null,
      },
    ],
    rawTable: {} as TableContext['rawTable'],
  };
}

function schemaFor(memberNullable: boolean) {
  const table = assignmentsTable(memberNullable);
  const formTable = promoteCompositeMemberWidgets(
    demoteUnpickableRelations(table, [binRelation]),
    [binRelation],
  );
  return zod4(zodFromTable(formTable));
}

describe('superValidate over a composite-picker form schema', () => {
  it('initializes required composite members to the unselected sentinel, not 0', async () => {
    const form = await superValidate(schemaFor(false));
    expect(form.data.aisle).toBe('');
    expect(form.data.shelf).toBe('');
  });

  it('rejects an untouched required composite pick on submit', async () => {
    const form = await superValidate(
      { aisle: '', shelf: '', note: 'untouched picker' },
      schemaFor(false),
    );
    expect(form.valid).toBe(false);
    expect(form.errors.aisle).toBeDefined();
    expect(form.errors.shelf).toBeDefined();
  });

  it('rejects absent required members (defaults flow into validation)', async () => {
    // A native submission omits the suppressed member fields entirely; the
    // '' defaults are applied and then validated, so a required composite
    // still fails loudly.
    const form = await superValidate({ note: 'nothing picked' }, schemaFor(false));
    expect(form.valid).toBe(false);
    expect(form.errors.aisle).toBeDefined();
    expect(form.errors.shelf).toBeDefined();
  });

  it('accepts a picked composite key (typed components)', async () => {
    const form = await superValidate({ aisle: 1, shelf: 2 }, schemaFor(false));
    expect(form.valid).toBe(true);
  });

  it('accepts string components from a decoded native submission', async () => {
    const form = await superValidate(
      { aisle: '1', shelf: '2' },
      schemaFor(false),
    );
    expect(form.valid).toBe(true);
  });

  it('accepts a cleared optional composite pick (nulls)', async () => {
    const form = await superValidate(
      { aisle: null, shelf: null },
      schemaFor(true),
    );
    expect(form.valid).toBe(true);
  });

  it('treats an enhanced clear and a native clear identically in the payload', async () => {
    // The enhanced picker writes '' on clear (applyComposite); the native
    // path deletes the fields so the '' defaults apply. Both must reach
    // buildMutationPayload as '' and normalize the same way: null for a
    // plain nullable member, dropped for a DB-supplied one.
    const { buildMutationPayload } = await import(
      '../../src/lib/form/mutation-payload.js'
    );
    const table = assignmentsTable(true);
    const withDefault = {
      ...table,
      columns: table.columns.map((c) =>
        c.name === 'shelf' ? { ...c, defaultExpr: '1' } : c,
      ),
    };
    const formTable = promoteCompositeMemberWidgets(
      demoteUnpickableRelations(withDefault, [binRelation]),
      [binRelation],
    );

    const cleared = await superValidate(
      { aisle: '', shelf: '', note: 'cleared' },
      zod4(zodFromTable(formTable)),
    );
    expect(cleared.valid).toBe(true);
    const payload = buildMutationPayload(
      formTable,
      cleared.data as Record<string, unknown>,
    );
    // Plain nullable member: cleared to null. DB-supplied member: dropped so
    // the default applies — matching the single-column picker contract.
    expect(payload.aisle).toBeNull();
    expect('shelf' in payload).toBe(false);
  });

  it('clears a defaulted component on update instead of keeping its old value', async () => {
    // On edit, dropping a DB-defaulted member would silently keep the old
    // component and leave the composite key half-cleared; update mode
    // forces explicit nulls for cleared relation members.
    const { buildMutationPayload } = await import(
      '../../src/lib/form/mutation-payload.js'
    );
    const table = assignmentsTable(true);
    const withDefault = {
      ...table,
      columns: table.columns.map((c) =>
        c.name === 'shelf' ? { ...c, defaultExpr: '1' } : c,
      ),
    };
    const formTable = promoteCompositeMemberWidgets(
      demoteUnpickableRelations(withDefault, [binRelation]),
      [binRelation],
    );

    const cleared = await superValidate(
      { aisle: '', shelf: '', note: 'cleared on edit' },
      zod4(zodFromTable(formTable)),
    );
    expect(cleared.valid).toBe(true);
    const payload = buildMutationPayload(
      formTable,
      cleared.data as Record<string, unknown>,
      'update',
    );
    expect(payload.aisle).toBeNull();
    expect(payload.shelf).toBeNull();
  });

  it('validates a decoded native submission end to end (no FormData/union 500)', async () => {
    // superforms refuses to parse a union-typed field from FormData, so the
    // native path must hand superValidate the converted object — this is the
    // regression for the crash a raw FormData submission would hit.
    const { readFormWithCompositePicks } = await import(
      '../../src/lib/server/composite-form.js'
    );
    const params = new URLSearchParams({
      __composite__aisle: '1,2',
      note: 'native pick',
    });
    const request = new Request(
      'http://ui.local/tables/public.bin_assignments/new',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      },
    );

    const submission = await readFormWithCompositePicks(request, [binRelation]);
    const form = await superValidate(
      submission as Record<string, unknown>,
      schemaFor(false),
    );

    expect(form.valid).toBe(true);
    expect(form.data.aisle).toBe('1');
    expect(form.data.shelf).toBe('2');
    expect(form.data.note).toBe('native pick');
  });

  it('normalizes a native nullable single-picker clear to null, not the option text', async () => {
    // The optional picker's clear option must carry value="" — an option
    // with a null value drops the attribute in SSR and a no-JS clear would
    // submit the option TEXT ('--') as the foreign key. The '' sentinel
    // flows through validation and buildMutationPayload normalizes it to
    // null.
    const { readFormWithCompositePicks } = await import(
      '../../src/lib/server/composite-form.js'
    );
    const { buildMutationPayload } = await import(
      '../../src/lib/form/mutation-payload.js'
    );
    const books: TableContext = {
      schema: 'public',
      name: 'books',
      qualifiedName: 'public.books',
      label: 'Books',
      description: null,
      aiDescription: null,
      primaryKey: ['id'],
      displayField: 'title',
      columns: [
        makeColumn({
          name: 'id',
          dataType: 'uuid',
          widget: 'uuid',
          isPrimaryKey: true,
          defaultExpr: 'gen_random_uuid()',
        }),
        makeColumn({ name: 'title', widget: 'text' }),
        makeColumn({
          name: 'author_id',
          dataType: 'uuid',
          widget: 'relation-select' as WidgetType,
          nullable: true,
          isForeignKey: true,
        }),
      ],
      relations: [],
      rawTable: {} as TableContext['rawTable'],
    };
    const singleConfig: RelationFieldConfig = {
      field: 'author_id',
      resource: 'public.authors',
      labelField: 'display_name',
      searchFields: ['display_name'],
    };
    const params = new URLSearchParams({ title: 'cleared fk', author_id: '' });
    const request = new Request('http://ui.local/tables/public.books/new', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    const submission = await readFormWithCompositePicks(request, [singleConfig]);
    const form = await superValidate(
      submission as Record<string, unknown>,
      zod4(zodFromTable(books)),
    );
    expect(form.valid).toBe(true);

    const payload = buildMutationPayload(
      books,
      form.data as Record<string, unknown>,
    );
    expect(payload.author_id).toBeNull();
    expect(payload.title).toBe('cleared fk');
  });
});
