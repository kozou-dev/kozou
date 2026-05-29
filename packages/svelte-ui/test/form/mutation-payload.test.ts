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

  it('keeps a real value for a DB-suppliable column (e.g. edit submit)', () => {
    const payload = buildMutationPayload(table, {
      id: '11111111-1111-1111-1111-111111111111',
      display_name: 'Ada Lovelace',
      deleted_at: null,
      slug: 'ada',
    });
    expect(payload.id).toBe('11111111-1111-1111-1111-111111111111');
    expect(payload.slug).toBe('ada');
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
});
