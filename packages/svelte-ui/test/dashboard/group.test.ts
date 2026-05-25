import { describe, expect, it } from 'vitest';

import type {
  SchemaContext,
  TableContext,
  ViewContext,
} from '@kozou/core';

import { groupForDashboard } from '../../src/lib/dashboard/group.js';

function makeTable(
  name: string,
  label: string,
  description: string | null = null,
): TableContext {
  return {
    schema: 'public',
    name,
    qualifiedName: `public.${name}`,
    label,
    description,
    aiDescription: null,
    primaryKey: ['id'],
    displayField: null,
    columns: [],
    relations: [],
    rawTable: {} as TableContext['rawTable'],
  };
}

function makeView(
  name: string,
  label: string,
  description: string | null = null,
): ViewContext {
  return {
    schema: 'public',
    name,
    qualifiedName: `public.${name}`,
    label,
    description,
    aiDescription: null,
    purpose: null,
    columns: [],
    underlyingTables: [],
    rawView: {} as ViewContext['rawView'],
  };
}

function makeSchema(
  tables: TableContext[],
  views: ViewContext[] = [],
): SchemaContext {
  return {
    meta: {
      serverVersion: '16.0',
      builtAt: '2026-05-25T00:00:00.000Z',
      sourceSchemas: ['public'],
    },
    tables,
    views,
    enums: [],
    concepts: [],
  };
}

describe('groupForDashboard', () => {
  it('returns tables and views sorted alphabetically by label', () => {
    const schema = makeSchema(
      [makeTable('books', 'Books'), makeTable('authors', 'Authors')],
      [
        makeView('public_books', 'Public Books'),
        makeView('all_concepts', 'All Concepts'),
      ],
    );

    const groups = groupForDashboard(schema);

    expect(groups.tables.map((t) => t.label)).toEqual(['Authors', 'Books']);
    expect(groups.views.map((v) => v.label)).toEqual([
      'All Concepts',
      'Public Books',
    ]);
  });

  it('projects each table / view to { qualifiedName, label, description }', () => {
    const schema = makeSchema(
      [makeTable('books', 'Books', 'Library catalogue')],
      [makeView('public_books', 'Public Books', 'Visible to everyone')],
    );

    const groups = groupForDashboard(schema);

    expect(groups.tables[0]).toEqual({
      qualifiedName: 'public.books',
      label: 'Books',
      description: 'Library catalogue',
    });
    expect(groups.views[0]).toEqual({
      qualifiedName: 'public.public_books',
      label: 'Public Books',
      description: 'Visible to everyone',
    });
  });
});
