import { describe, it, expect } from 'vitest';
import type { RawTable, RawView } from '@kozou/core';
import {
  filterTables,
  filterViews,
  pruneDanglingForeignKeys,
} from '../src/filter.js';

function table(schema: string, name: string, partial: Partial<RawTable> = {}): RawTable {
  return {
    schema,
    name,
    comment: null,
    columns: [],
    primaryKey: [],
    foreignKeys: [],
    checks: [],
    indexes: [],
    rowCountEstimate: null,
    ...partial,
  };
}

function view(schema: string, name: string): RawView {
  return {
    schema,
    name,
    comment: null,
    columns: [],
    underlyingTables: [],
    definition: '',
  };
}

describe('filterTables', () => {
  const sample: RawTable[] = [
    table('public', 'users'),
    table('public', 'orders'),
    table('public', 'audit_log'),
    table('auth', 'sessions'),
    table('auth', 'users'),
  ];

  it('returns all tables when no filters are set', () => {
    expect(filterTables(sample, {}).map((t) => `${t.schema}.${t.name}`)).toEqual([
      'public.users',
      'public.orders',
      'public.audit_log',
      'auth.sessions',
      'auth.users',
    ]);
  });

  it('include with bare name expands to *.<name> across schemas', () => {
    const out = filterTables(sample, { include: ['users'] }).map(
      (t) => `${t.schema}.${t.name}`,
    );
    expect(out.sort()).toEqual(['auth.users', 'public.users']);
  });

  it('include with schema.table is exact', () => {
    const out = filterTables(sample, { include: ['public.users'] }).map(
      (t) => `${t.schema}.${t.name}`,
    );
    expect(out).toEqual(['public.users']);
  });

  it('include with schema.* matches entire schema', () => {
    const out = filterTables(sample, { include: ['auth.*'] }).map(
      (t) => `${t.schema}.${t.name}`,
    );
    expect(out.sort()).toEqual(['auth.sessions', 'auth.users']);
  });

  it('include with prefix glob (audit_*) matches table-name prefix', () => {
    const out = filterTables(sample, { include: ['audit_*'] }).map(
      (t) => `${t.schema}.${t.name}`,
    );
    expect(out).toEqual(['public.audit_log']);
  });

  it('exclude removes matching tables', () => {
    const out = filterTables(sample, { exclude: ['audit_*'] }).map(
      (t) => `${t.schema}.${t.name}`,
    );
    expect(out.sort()).toEqual([
      'auth.sessions',
      'auth.users',
      'public.orders',
      'public.users',
    ]);
  });

  it('exclude wins when both include and exclude match', () => {
    const out = filterTables(sample, {
      include: ['public.*'],
      exclude: ['public.audit_log'],
    }).map((t) => `${t.schema}.${t.name}`);
    expect(out.sort()).toEqual(['public.orders', 'public.users']);
  });

  it('wildcard does not cross schema boundary', () => {
    // `*.users` must match `<schema>.users`, never multi-segment names.
    const weird: RawTable[] = [table('public', 'users'), table('a.b', 'users')];
    const out = filterTables(weird, { include: ['*.users'] }).map(
      (t) => `${t.schema}.${t.name}`,
    );
    expect(out).toEqual(['public.users']);
  });

  it('? matches exactly one non-dot char', () => {
    const data: RawTable[] = [
      table('public', 't1'),
      table('public', 't12'),
      table('public', 't'),
    ];
    const out = filterTables(data, { include: ['public.t?'] }).map((t) => t.name);
    expect(out).toEqual(['t1']);
  });

  it('escapes regex metacharacters in literal segments', () => {
    const data: RawTable[] = [
      table('public', 'a+b'),
      table('public', 'a_b'),
    ];
    const out = filterTables(data, { include: ['public.a+b'] }).map((t) => t.name);
    expect(out).toEqual(['a+b']);
  });
});

describe('filterViews', () => {
  it('applies the same include/exclude semantics as tables', () => {
    const data: RawView[] = [
      view('public', 'vw_inventory'),
      view('public', 'vw_sales'),
      view('reporting', 'vw_inventory'),
    ];
    expect(
      filterViews(data, { include: ['vw_inventory'] }).map((v) => `${v.schema}.${v.name}`).sort(),
    ).toEqual(['public.vw_inventory', 'reporting.vw_inventory']);
    expect(
      filterViews(data, { exclude: ['public.*'] }).map((v) => `${v.schema}.${v.name}`),
    ).toEqual(['reporting.vw_inventory']);
  });
});

describe('pruneDanglingForeignKeys', () => {
  it('drops FKs whose target is no longer in the table set', () => {
    const tables: RawTable[] = [
      table('public', 'orders', {
        foreignKeys: [
          {
            name: 'orders_user_id_fkey',
            columns: ['user_id'],
            referencedSchema: 'public',
            referencedTable: 'users',
            referencedColumns: ['id'],
            onDelete: 'NO ACTION',
            onUpdate: 'NO ACTION',
            comment: null,
          },
          {
            name: 'orders_audit_id_fkey',
            columns: ['audit_id'],
            referencedSchema: 'public',
            referencedTable: 'audit_log',
            referencedColumns: ['id'],
            onDelete: 'NO ACTION',
            onUpdate: 'NO ACTION',
            comment: null,
          },
        ],
      }),
      table('public', 'users'),
      // `audit_log` was filtered out — the FK pointing at it must be
      // pruned so downstream consumers never see a dangling reference.
    ];
    pruneDanglingForeignKeys(tables);
    const orders = tables.find((t) => t.name === 'orders')!;
    expect(orders.foreignKeys.map((fk) => fk.name)).toEqual(['orders_user_id_fkey']);
  });

  it('keeps all FKs when every target is present', () => {
    const tables: RawTable[] = [
      table('public', 'orders', {
        foreignKeys: [
          {
            name: 'orders_user_id_fkey',
            columns: ['user_id'],
            referencedSchema: 'public',
            referencedTable: 'users',
            referencedColumns: ['id'],
            onDelete: 'NO ACTION',
            onUpdate: 'NO ACTION',
            comment: null,
          },
        ],
      }),
      table('public', 'users'),
    ];
    pruneDanglingForeignKeys(tables);
    expect(tables[0].foreignKeys).toHaveLength(1);
  });
});
