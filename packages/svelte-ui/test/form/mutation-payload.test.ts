import { describe, expect, it } from 'vitest';

import type { ColumnContext, TableContext, WidgetType } from '@kozou/core';

import { buildMutationPayload } from '../../src/lib/form/mutation-payload.js';

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
    name: 'authors',
    qualifiedName: 'public.authors',
    label: 'Authors',
    description: null,
    aiDescription: null,
    primaryKey: ['id'],
    displayField: 'display_name',
    columns,
    relations: [],
    rawTable: {} as TableContext['rawTable'],
  };
}

describe('buildMutationPayload', () => {
  const table = makeTable([
    makeColumn({ name: 'id', widget: 'uuid', defaultExpr: 'gen_random_uuid()' }),
    makeColumn({ name: 'display_name', widget: 'text', nullable: false }),
    makeColumn({ name: 'deleted_at', widget: 'datetime', nullable: true }),
    makeColumn({ name: 'slug', widget: 'text', readonly: true }),
  ]);

  it('drops empty DB-suppliable columns so the database default applies', () => {
    const payload = buildMutationPayload(table, {
      id: '',
      display_name: 'Ada Lovelace',
      deleted_at: null,
      slug: '',
    });
    // id (default) and slug (read-only) are dropped; the rest pass.
    expect(payload).toEqual({ display_name: 'Ada Lovelace', deleted_at: null });
    expect('id' in payload).toBe(false);
    expect('slug' in payload).toBe(false);
  });

  it('keeps a real value for a defaulted column but always drops read-only ones', () => {
    const payload = buildMutationPayload(table, {
      id: '11111111-1111-1111-1111-111111111111',
      display_name: 'Ada Lovelace',
      deleted_at: null,
      slug: 'ada',
    });
    // A defaulted (but operator-editable) column keeps its real value.
    expect(payload.id).toBe('11111111-1111-1111-1111-111111111111');
    // A read-only column is never writable through the form: the edit
    // submission carries the hydrated current value, and PATCHing it back
    // would hard-error on a generated column (it also closes the
    // forged-value path through the form action).
    expect('slug' in payload).toBe(false);
  });

  it('keeps explicit nulls for non-default nullable columns', () => {
    const payload = buildMutationPayload(table, {
      id: '',
      display_name: 'Ada Lovelace',
      deleted_at: null,
      slug: '',
    });
    // deleted_at is nullable with no default, so an explicit null is a
    // meaningful value and must be forwarded.
    expect(payload.deleted_at).toBeNull();
  });

  it('keeps an empty string for a column the form genuinely owns', () => {
    // display_name has no default and is not read-only, so an empty
    // string is the operator's input, not a "let the DB decide" signal.
    const payload = buildMutationPayload(table, {
      id: '',
      display_name: '',
      deleted_at: null,
      slug: '',
    });
    expect(payload.display_name).toBe('');
  });

  it('clears a relation-select to null when no option is selected', () => {
    const withFk = makeTable([
      makeColumn({ name: 'id', widget: 'uuid', defaultExpr: 'gen_random_uuid()' }),
      makeColumn({
        name: 'author_id',
        widget: 'relation-select',
        dataType: 'uuid',
        nullable: true,
        isForeignKey: true,
      }),
    ]);

    // An empty selection must become null (the uuid FK column cannot store "").
    expect(buildMutationPayload(withFk, { id: '', author_id: '' }).author_id).toBeNull();
    // An explicit null passes through unchanged.
    expect(buildMutationPayload(withFk, { id: '', author_id: null }).author_id).toBeNull();
    // A real selection is forwarded verbatim.
    expect(
      buildMutationPayload(withFk, {
        id: '',
        author_id: '22222222-2222-2222-2222-222222222222',
      }).author_id,
    ).toBe('22222222-2222-2222-2222-222222222222');
  });

  it('keeps the stored value for an empty defaulted NOT NULL relation-select on update', () => {
    // A non-nullable DB-suppliable FK cannot hold null and SQL cannot say
    // "reset to DEFAULT" through a plain update payload, so the empty value
    // is dropped — the stored value is kept (#95 / update-mode semantics).
    const withDefaultedFk = makeTable([
      makeColumn({ name: 'id', widget: 'uuid', defaultExpr: 'gen_random_uuid()' }),
      makeColumn({
        name: 'owner_id',
        widget: 'relation-select',
        dataType: 'uuid',
        nullable: false,
        defaultExpr: 'current_owner()',
        isForeignKey: true,
      }),
    ]);

    const updated = buildMutationPayload(
      withDefaultedFk,
      { id: '', owner_id: '' },
      'update',
    );
    expect('owner_id' in updated).toBe(false);

    // On create the same empty value is also dropped, so the DEFAULT applies.
    const created = buildMutationPayload(withDefaultedFk, { id: '', owner_id: '' });
    expect('owner_id' in created).toBe(false);
  });

  it('still clears an empty nullable defaulted relation-select to null on update', () => {
    const withNullableDefaultedFk = makeTable([
      makeColumn({ name: 'id', widget: 'uuid', defaultExpr: 'gen_random_uuid()' }),
      makeColumn({
        name: 'group_id',
        widget: 'relation-select',
        dataType: 'uuid',
        nullable: true,
        defaultExpr: 'default_group()',
        isForeignKey: true,
      }),
    ]);

    // Dropping it instead would silently keep the old value — the operator
    // cleared the picker, so the update must write null.
    const updated = buildMutationPayload(
      withNullableDefaultedFk,
      { id: '', group_id: '' },
      'update',
    );
    expect(updated.group_id).toBeNull();
  });
});
