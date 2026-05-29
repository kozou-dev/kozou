import { describe, expect, it } from 'vitest';

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

describe('zodFromTable', () => {
  it('builds a zod object schema with one key per column', () => {
    const schema = zodFromTable(
      makeTable([
        makeColumn({ name: 'title', widget: 'text', nullable: false }),
        makeColumn({
          name: 'published',
          widget: 'boolean',
          dataType: 'boolean',
          nullable: false,
        }),
      ]),
    );

    const parsed = schema.safeParse({ title: 'A Book', published: 'true' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toMatchObject({ title: 'A Book', published: true });
    }
  });

  it('accepts null or a value for nullable columns (key always present)', () => {
    // superforms submits every field, so a nullable column appears as
    // an explicit null rather than an omitted key. The schema therefore
    // accepts null or a value but treats the field as required-present.
    const schema = zodFromTable(
      makeTable([
        makeColumn({ name: 'title', widget: 'text', nullable: false }),
        makeColumn({ name: 'subtitle', widget: 'text', nullable: true }),
      ]),
    );

    expect(
      schema.safeParse({ title: 'A Book', subtitle: null }).success,
    ).toBe(true);
    expect(
      schema.safeParse({ title: 'A Book', subtitle: 'Notes' }).success,
    ).toBe(true);
    expect(schema.safeParse({ subtitle: 'orphan' }).success).toBe(false);
  });
});
