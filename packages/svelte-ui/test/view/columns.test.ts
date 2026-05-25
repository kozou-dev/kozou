import { describe, expect, it } from 'vitest';

import type {
  ColumnContext,
  ViewContext,
  WidgetType,
} from '@kozou/core';

import {
  pickViewDisplayColumns,
  pickViewSearchFields,
} from '../../src/lib/view/columns.js';

function makeColumn(
  name: string,
  dataType: string,
  overrides: Partial<ColumnContext> = {},
): ColumnContext {
  return {
    name,
    dataType,
    nullable: true,
    defaultExpr: null,
    isPrimaryKey: false,
    isForeignKey: false,
    label: name,
    description: null,
    aiDescription: null,
    widget: 'text' as WidgetType,
    enumValues: null,
    readonly: true,
    ...overrides,
  };
}

function makeView(columns: ColumnContext[]): ViewContext {
  return {
    schema: 'public',
    name: 'public_books',
    qualifiedName: 'public.public_books',
    label: 'Public Books',
    description: null,
    aiDescription: null,
    purpose: null,
    columns,
    underlyingTables: [],
    rawView: {} as ViewContext['rawView'],
  };
}

describe('pickViewDisplayColumns', () => {
  it('clamps to the first 5 columns in source order', () => {
    const view = makeView([
      makeColumn('a', 'text'),
      makeColumn('b', 'text'),
      makeColumn('c', 'text'),
      makeColumn('d', 'text'),
      makeColumn('e', 'text'),
      makeColumn('f', 'text'),
      makeColumn('g', 'text'),
    ]);

    const picked = pickViewDisplayColumns(view);

    expect(picked.map((c) => c.name)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});

describe('pickViewSearchFields', () => {
  it('keeps only the text-like columns (text / character varying / uuid / etc.)', () => {
    const view = makeView([
      makeColumn('title', 'text'),
      makeColumn('subtitle', 'character varying'),
      makeColumn('legacy_id', 'uuid'),
      makeColumn('rank', 'integer'),
      makeColumn('payload', 'jsonb'),
      makeColumn('created_at', 'timestamptz'),
      makeColumn('blob', 'bytea'),
      makeColumn('display_name', 'citext'),
    ]);

    const fields = pickViewSearchFields(view);

    expect(fields).toEqual([
      'title',
      'subtitle',
      'legacy_id',
      'display_name',
    ]);
  });
});
