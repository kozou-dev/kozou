import { describe, expect, it } from 'vitest';

import type { ColumnContext, TableContext, WidgetType } from '@kozou/core';

import { applyPrivilegeReadonly } from '../../src/lib/form/privilege-readonly.js';

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
    name: 'orders',
    qualifiedName: 'public.orders',
    label: 'Orders',
    description: null,
    aiDescription: null,
    primaryKey: ['id'],
    displayField: null,
    columns,
    relations: [],
    rawTable: {} as TableContext['rawTable'],
  };
}

const byName = (t: TableContext) => new Map(t.columns.map((c) => [c.name, c]));

describe('applyPrivilegeReadonly (#99)', () => {
  const table = makeTable([
    // write-once: insertable, not updatable
    makeColumn({ name: 'created_by', insertable: true, updatable: false }),
    // not insertable, but updatable
    makeColumn({ name: 'reviewed_at', insertable: false, updatable: true }),
    // fully writable
    makeColumn({ name: 'note', insertable: true, updatable: true }),
    // hint-locked regardless of privileges
    makeColumn({ name: 'locked', readonly: true, insertable: true, updatable: true }),
  ]);

  it('create mode: a non-insertable column becomes read-only; a write-once column stays editable', () => {
    const cols = byName(applyPrivilegeReadonly(table, 'create'));
    expect(cols.get('created_by')!.readonly).toBe(false); // insertable -> editable on create
    expect(cols.get('reviewed_at')!.readonly).toBe(true); // not insertable -> locked on create
    expect(cols.get('note')!.readonly).toBe(false);
    expect(cols.get('locked')!.readonly).toBe(true); // hint preserved
  });

  it('update mode: a non-updatable column becomes read-only; an insert-only column stays editable', () => {
    const cols = byName(applyPrivilegeReadonly(table, 'update'));
    expect(cols.get('created_by')!.readonly).toBe(true); // not updatable -> locked on edit
    expect(cols.get('reviewed_at')!.readonly).toBe(false); // updatable -> editable on edit
    expect(cols.get('note')!.readonly).toBe(false);
    expect(cols.get('locked')!.readonly).toBe(true);
  });

  it('is a no-op when privileges were not evaluated (insertable/updatable undefined)', () => {
    const plain = makeTable([makeColumn({ name: 'a' }), makeColumn({ name: 'b', readonly: true })]);
    for (const mode of ['create', 'update'] as const) {
      const cols = byName(applyPrivilegeReadonly(plain, mode));
      expect(cols.get('a')!.readonly).toBe(false);
      expect(cols.get('b')!.readonly).toBe(true);
    }
  });

  it('does not mutate the input table', () => {
    const input = makeTable([makeColumn({ name: 'reviewed_at', insertable: false, updatable: true })]);
    applyPrivilegeReadonly(input, 'create');
    expect(input.columns[0]!.readonly).toBe(false);
  });
});
