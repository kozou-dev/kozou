import { describe, expect, it, vi } from 'vitest';

import type { ColumnContext, SchemaContext, TableContext } from '@kozou/core';

import { resolveFkLabels } from '../../src/lib/detail/resolve-fk-labels.js';

function makeColumn(name: string, overrides: Partial<ColumnContext> = {}): ColumnContext {
  return {
    name,
    dataType: 'uuid',
    nullable: true,
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

function makeTable(
  name: string,
  overrides: Partial<TableContext> = {},
): TableContext {
  return {
    schema: 'public',
    name,
    qualifiedName: `public.${name}`,
    label: name,
    description: null,
    aiDescription: null,
    primaryKey: ['id'],
    displayField: null,
    columns: [makeColumn('id', { isPrimaryKey: true })],
    relations: [],
    rawTable: {} as TableContext['rawTable'],
    ...overrides,
  };
}

function makeSchema(tables: TableContext[]): SchemaContext {
  return {
    meta: { serverVersion: 'test', builtAt: '2026-05-28T00:00:00Z', sourceSchemas: ['public'] },
    tables,
    views: [],
    enums: [],
    concepts: [],
  };
}

describe('resolveFkLabels', () => {
  it('returns an empty map when the table has no relations', async () => {
    const table = makeTable('books');
    const schema = makeSchema([table]);
    const loadRow = vi.fn();

    const result = await resolveFkLabels({
      table,
      row: { id: 'x' },
      schema,
      loadRow,
    });

    expect(result).toEqual({});
    expect(loadRow).not.toHaveBeenCalled();
  });

  it('skips FK columns whose value is null or undefined', async () => {
    const authors = makeTable('authors', { displayField: 'display_name' });
    const books = makeTable('books', {
      columns: [
        makeColumn('id', { isPrimaryKey: true }),
        makeColumn('author_id', { isForeignKey: true }),
      ],
      relations: [
        {
          field: 'author_id',
          references: { schema: 'public', table: 'authors', column: 'id' },
          cardinality: 'many-to-one',
          meaning: null,
        },
      ],
    });
    const schema = makeSchema([authors, books]);
    const loadRow = vi.fn();

    const result = await resolveFkLabels({
      table: books,
      row: { id: 'b1', author_id: null },
      schema,
      loadRow,
    });

    expect(result).toEqual({});
    expect(loadRow).not.toHaveBeenCalled();
  });

  it('projects the referenced table.displayField onto the FK column', async () => {
    const authors = makeTable('authors', {
      displayField: 'display_name',
      columns: [
        makeColumn('id', { isPrimaryKey: true }),
        makeColumn('display_name', { dataType: 'text' }),
      ],
    });
    const books = makeTable('books', {
      relations: [
        {
          field: 'author_id',
          references: { schema: 'public', table: 'authors', column: 'id' },
          cardinality: 'many-to-one',
          meaning: null,
        },
      ],
    });
    const schema = makeSchema([authors, books]);
    const loadRow = vi.fn(async (qn, id) => {
      if (qn === 'public.authors' && id === 'a1') {
        return { id: 'a1', display_name: 'Margaret Atwood' };
      }
      return null;
    });

    const result = await resolveFkLabels({
      table: books,
      row: { id: 'b1', author_id: 'a1' },
      schema,
      loadRow,
    });

    expect(result).toEqual({
      author_id: {
        value: 'a1',
        label: 'Margaret Atwood',
        referencedQualifiedName: 'public.authors',
      },
    });
  });

  it('returns label: null when the referenced table is missing from the schema', async () => {
    const books = makeTable('books', {
      relations: [
        {
          field: 'author_id',
          references: { schema: 'public', table: 'authors', column: 'id' },
          cardinality: 'many-to-one',
          meaning: null,
        },
      ],
    });
    // `authors` deliberately absent from the schema.
    const schema = makeSchema([books]);
    const loadRow = vi.fn();

    const result = await resolveFkLabels({
      table: books,
      row: { id: 'b1', author_id: 'a1' },
      schema,
      loadRow,
    });

    expect(result).toEqual({
      author_id: {
        value: 'a1',
        label: null,
        referencedQualifiedName: 'public.authors',
      },
    });
    expect(loadRow).not.toHaveBeenCalled();
  });

  it('returns label: null when the referenced table has no displayField', async () => {
    const authors = makeTable('authors', { displayField: null });
    const books = makeTable('books', {
      relations: [
        {
          field: 'author_id',
          references: { schema: 'public', table: 'authors', column: 'id' },
          cardinality: 'many-to-one',
          meaning: null,
        },
      ],
    });
    const schema = makeSchema([authors, books]);
    const loadRow = vi.fn(async () => ({ id: 'a1', display_name: 'M.' }));

    const result = await resolveFkLabels({
      table: books,
      row: { id: 'b1', author_id: 'a1' },
      schema,
      loadRow,
    });

    expect(result.author_id?.label).toBeNull();
  });

  it('returns label: null when the referenced row is null (cache / fetch miss)', async () => {
    const authors = makeTable('authors', { displayField: 'display_name' });
    const books = makeTable('books', {
      relations: [
        {
          field: 'author_id',
          references: { schema: 'public', table: 'authors', column: 'id' },
          cardinality: 'many-to-one',
          meaning: null,
        },
      ],
    });
    const schema = makeSchema([authors, books]);
    const loadRow = vi.fn(async () => null);

    const result = await resolveFkLabels({
      table: books,
      row: { id: 'b1', author_id: 'a1' },
      schema,
      loadRow,
    });

    expect(result.author_id?.label).toBeNull();
  });

  it('issues lookups in parallel via Promise.all', async () => {
    const authors = makeTable('authors', { displayField: 'display_name' });
    const editions = makeTable('editions', { displayField: 'isbn' });
    const books = makeTable('books', {
      relations: [
        {
          field: 'author_id',
          references: { schema: 'public', table: 'authors', column: 'id' },
          cardinality: 'many-to-one',
          meaning: null,
        },
        {
          field: 'edition_id',
          references: { schema: 'public', table: 'editions', column: 'id' },
          cardinality: 'many-to-one',
          meaning: null,
        },
      ],
    });
    const schema = makeSchema([authors, editions, books]);

    const inFlight = new Set<string>();
    let observedMaxParallel = 0;
    const loadRow = vi.fn(async (qn) => {
      inFlight.add(qn);
      observedMaxParallel = Math.max(observedMaxParallel, inFlight.size);
      await new Promise((res) => setTimeout(res, 5));
      inFlight.delete(qn);
      if (qn === 'public.authors') {
        return { id: 'a1', display_name: 'Margaret Atwood' };
      }
      if (qn === 'public.editions') {
        return { id: 'e1', isbn: '978-...' };
      }
      return null;
    });

    await resolveFkLabels({
      table: books,
      row: { id: 'b1', author_id: 'a1', edition_id: 'e1' },
      schema,
      loadRow,
    });

    expect(observedMaxParallel).toBe(2);
  });
});
