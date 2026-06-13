import { describe, expect, it } from 'vitest';

import type {
  ColumnContext,
  FunctionArgContext,
  FunctionContext,
  SchemaContext,
  TableContext,
} from '@kozou/core';

import { buildActionForm } from '../../src/lib/form/action-form.js';
import { dbCanSupplyColumn } from '../../src/lib/form/zod-from-column.js';

function arg(name: string, overrides: Partial<FunctionArgContext> = {}): FunctionArgContext {
  return { name, typeName: 'text', hasDefault: false, widget: 'text', ...overrides };
}

function fn(args: FunctionArgContext[], overrides: Partial<FunctionContext> = {}): FunctionContext {
  return {
    schema: 'public',
    name: 'approve_order',
    qualifiedName: 'public.approve_order',
    label: 'Approve an order',
    description: 'desc',
    aiDescription: 'not idempotent',
    policy: ['managers only'],
    args,
    returns: { kind: 'void', typeName: 'void' },
    volatility: 'volatile',
    security: 'invoker',
    publicCallable: false,
    rawFunction: {} as FunctionContext['rawFunction'],
    ...overrides,
  };
}

function column(name: string, overrides: Partial<ColumnContext> = {}): ColumnContext {
  return {
    name,
    dataType: 'uuid',
    nullable: false,
    defaultExpr: null,
    isPrimaryKey: false,
    isForeignKey: false,
    label: name,
    description: null,
    aiDescription: null,
    widget: 'text',
    enumValues: null,
    readonly: false,
    ...overrides,
  };
}

function table(name: string, overrides: Partial<TableContext> = {}): TableContext {
  return {
    schema: 'public',
    name,
    qualifiedName: `public.${name}`,
    label: name,
    description: null,
    aiDescription: null,
    primaryKey: ['id'],
    displayField: null,
    columns: [column('id', { isPrimaryKey: true })],
    relations: [],
    rawTable: {} as TableContext['rawTable'],
    ...overrides,
  };
}

function schema(tables: TableContext[] = []): SchemaContext {
  return {
    meta: { serverVersion: 'test', builtAt: '2026-06-13T00:00:00Z', sourceSchemas: ['public'] },
    tables,
    views: [],
    enums: [],
    concepts: [],
    functions: [],
  };
}

describe('buildActionForm', () => {
  it('maps scalar arguments to columns, required iff no DEFAULT', () => {
    const action = buildActionForm(
      fn([arg('order_id', { widget: 'uuid', typeName: 'uuid' }), arg('qty', { widget: 'number', hasDefault: true })]),
      schema(),
    );
    const order = action.columns.find((c) => c.name === 'order_id')!;
    const qty = action.columns.find((c) => c.name === 'qty')!;
    expect(order.widget).toBe('uuid');
    expect(dbCanSupplyColumn(order)).toBe(false); // required (no default)
    expect(dbCanSupplyColumn(qty)).toBe(true); // optional (has default)
    expect(action.view.args.find((a) => a.name === 'order_id')!.required).toBe(true);
    expect(action.view.args.find((a) => a.name === 'qty')!.required).toBe(false);
  });

  it('carries enum members and the function advisory into the view model', () => {
    const action = buildActionForm(
      fn([arg('status', { widget: 'enum-select', enumValues: ['pending', 'shipped'] })]),
      schema(),
    );
    expect(action.view.args[0].widget).toBe('enum-select');
    expect(action.view.args[0].enumValues).toEqual(['pending', 'shipped']);
    expect(action.view.aiDescription).toBe('not idempotent');
    expect(action.view.policy).toEqual(['managers only']);
    expect(action.view.security).toBe('invoker');
  });

  it('builds a relation-select picker when the hint targets a single-PK, searchable table', () => {
    const orders = table('orders', {
      primaryKey: ['id'],
      displayField: 'code',
      columns: [
        column('id', { isPrimaryKey: true }),
        column('code', { dataType: 'text', widget: 'text' }),
      ],
    });
    const action = buildActionForm(
      fn([
        arg('order_id', {
          widget: 'relation-select',
          typeName: 'uuid',
          relation: { schema: 'public', table: 'orders', column: 'id' },
        }),
      ]),
      schema([orders]),
    );
    expect(action.columns[0].widget).toBe('relation-select');
    expect(action.relations).toEqual([
      { field: 'order_id', resource: 'public.orders', labelField: 'code', searchFields: ['code'] },
    ]);
  });

  it('demotes a relation hint to a scalar input when the target has no searchable label', () => {
    // orders has only a uuid PK and no text label column -> picker unusable.
    const orders = table('orders', { primaryKey: ['id'], displayField: null });
    const action = buildActionForm(
      fn([
        arg('order_id', {
          widget: 'relation-select',
          typeName: 'uuid',
          relation: { schema: 'public', table: 'orders', column: 'id' },
        }),
      ]),
      schema([orders]),
    );
    expect(action.relations).toEqual([]);
    expect(action.columns[0].widget).toBe('uuid'); // scalar fallback
  });

  it('demotes a relation hint that does not target the single primary key', () => {
    const orders = table('orders', {
      primaryKey: ['id'],
      displayField: 'code',
      columns: [
        column('id', { isPrimaryKey: true }),
        column('code', { dataType: 'text', widget: 'text' }),
      ],
    });
    const action = buildActionForm(
      fn([
        arg('order_code', {
          widget: 'relation-select',
          typeName: 'text',
          relation: { schema: 'public', table: 'orders', column: 'code' }, // not the PK
        }),
      ]),
      schema([orders]),
    );
    expect(action.relations).toEqual([]);
    expect(action.columns[0].widget).toBe('text');
  });
});
