import { describe, expect, it } from 'vitest';

import type { ColumnContext, SchemaContext, TableContext } from '@kozou/core';

import {
  demoteUnpickableRelations,
  relationFieldConfigs,
  scalarWidgetForDataType,
} from '../../src/lib/form/relation-field-config.js';

function makeColumn(
  name: string,
  overrides: Partial<ColumnContext> = {},
): ColumnContext {
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
    meta: {
      serverVersion: 'test',
      builtAt: '2026-06-10T00:00:00Z',
      sourceSchemas: ['public'],
    },
    tables,
    views: [],
    enums: [],
    concepts: [],
  };
}

const authors = makeTable('authors', {
  displayField: 'display_name',
  columns: [
    makeColumn('id', { isPrimaryKey: true }),
    makeColumn('display_name', { dataType: 'text' }),
  ],
});

function booksWith(relation: TableContext['relations'][number]): TableContext {
  return makeTable('books', {
    columns: [
      makeColumn('id', { isPrimaryKey: true }),
      makeColumn('author_id', { isForeignKey: true }),
    ],
    relations: [relation],
  });
}

describe('relationFieldConfigs', () => {
  it('maps a single-column FK to the target displayField with a text search', () => {
    const books = booksWith({
      field: 'author_id',
      fields: ['author_id'],
      references: { schema: 'public', table: 'authors', column: 'id', columns: ['id'] },
      cardinality: 'many-to-one',
      meaning: null,
    });

    expect(relationFieldConfigs(books, makeSchema([authors, books]))).toEqual([
      {
        field: 'author_id',
        resource: 'public.authors',
        labelField: 'display_name',
        searchFields: ['display_name'],
      },
    ]);
  });

  it('normalizes a v1.0-shaped relation that omits fields / columns', () => {
    // A relation persisted before the additive widening carries only the
    // scalar `field` / `references.column`; the reader must treat it as a
    // single-column relation.
    const books = booksWith({
      field: 'author_id',
      references: { schema: 'public', table: 'authors', column: 'id' },
      cardinality: 'many-to-one',
      meaning: null,
    });

    expect(relationFieldConfigs(books, makeSchema([authors, books]))).toEqual([
      {
        field: 'author_id',
        resource: 'public.authors',
        labelField: 'display_name',
        searchFields: ['display_name'],
      },
    ]);
  });

  it('skips composite (multi-column) foreign keys', () => {
    const target = makeTable('order_lines', {
      primaryKey: ['order_id', 'line_no'],
      displayField: 'product',
      columns: [
        makeColumn('order_id', { isPrimaryKey: true, dataType: 'integer' }),
        makeColumn('line_no', { isPrimaryKey: true, dataType: 'integer' }),
        makeColumn('product', { dataType: 'text' }),
      ],
    });
    const shipments = makeTable('shipments', {
      relations: [
        {
          field: 'order_id',
          fields: ['order_id', 'line_no'],
          references: {
            schema: 'public',
            table: 'order_lines',
            column: 'order_id',
            columns: ['order_id', 'line_no'],
          },
          cardinality: 'many-to-one',
          meaning: null,
        },
      ],
    });

    expect(
      relationFieldConfigs(shipments, makeSchema([target, shipments])),
    ).toEqual([]);
  });

  it('skips a relation whose target table is absent from the schema', () => {
    const books = booksWith({
      field: 'author_id',
      fields: ['author_id'],
      references: { schema: 'public', table: 'authors', column: 'id', columns: ['id'] },
      cardinality: 'many-to-one',
      meaning: null,
    });
    // `authors` deliberately omitted.
    expect(relationFieldConfigs(books, makeSchema([books]))).toEqual([]);
  });

  it('skips a foreign key that references a non-PK unique column', () => {
    // editions.isbn is UNIQUE but not the primary key; a FK pointing at it
    // cannot use the PK-keyed picker (the option id would be the target PK).
    const editions = makeTable('editions', {
      displayField: 'isbn',
      primaryKey: ['id'],
      columns: [
        makeColumn('id', { isPrimaryKey: true }),
        makeColumn('isbn', { dataType: 'text' }),
      ],
    });
    const stock = makeTable('stock', {
      relations: [
        {
          field: 'edition_isbn',
          fields: ['edition_isbn'],
          references: {
            schema: 'public',
            table: 'editions',
            column: 'isbn',
            columns: ['isbn'],
          },
          cardinality: 'many-to-one',
          meaning: null,
        },
      ],
    });

    expect(relationFieldConfigs(stock, makeSchema([editions, stock]))).toEqual(
      [],
    );
  });

  it('skips a relation whose label column is not text-searchable', () => {
    // widgets has no name/title column, so the displayField falls back to the
    // uuid primary key: a non-searchable label, so it gets no picker config.
    const keyed = makeTable('widgets', {
      displayField: null, // inferDisplayField would fall back to the PK
      primaryKey: ['id'],
      columns: [makeColumn('id', { isPrimaryKey: true, dataType: 'uuid' })],
    });
    const uses = makeTable('uses', {
      relations: [
        {
          field: 'widget_id',
          fields: ['widget_id'],
          references: { schema: 'public', table: 'widgets', column: 'id', columns: ['id'] },
          cardinality: 'many-to-one',
          meaning: null,
        },
      ],
    });

    expect(relationFieldConfigs(uses, makeSchema([keyed, uses]))).toEqual([]);
  });

  it.each(['text[]', 'character varying[]'])(
    'skips a relation whose label column is an array type (%s)',
    (dataType) => {
      const target = makeTable('tags', {
        displayField: 'name',
        columns: [
          makeColumn('id', { isPrimaryKey: true, dataType: 'uuid' }),
          makeColumn('name', { dataType }),
        ],
      });
      const tagged = makeTable('tagged', {
        relations: [
          {
            field: 'tag_id',
            fields: ['tag_id'],
            references: { schema: 'public', table: 'tags', column: 'id', columns: ['id'] },
            cardinality: 'many-to-one',
            meaning: null,
          },
        ],
      });

      expect(relationFieldConfigs(tagged, makeSchema([target, tagged]))).toEqual(
        [],
      );
    },
  );

  it('searches a label whose type carries a length modifier', () => {
    const target = makeTable('tags', {
      displayField: 'name',
      columns: [
        makeColumn('id', { isPrimaryKey: true, dataType: 'uuid' }),
        makeColumn('name', { dataType: 'character varying(255)' }),
      ],
    });
    const tagged = makeTable('tagged', {
      relations: [
        {
          field: 'tag_id',
          fields: ['tag_id'],
          references: { schema: 'public', table: 'tags', column: 'id', columns: ['id'] },
          cardinality: 'many-to-one',
          meaning: null,
        },
      ],
    });

    expect(relationFieldConfigs(tagged, makeSchema([target, tagged]))).toEqual([
      {
        field: 'tag_id',
        resource: 'public.tags',
        labelField: 'name',
        searchFields: ['name'],
      },
    ]);
  });
});

describe('scalarWidgetForDataType', () => {
  it.each([
    ['uuid', 'uuid'],
    ['boolean', 'boolean'],
    ['bool', 'boolean'],
    ['date', 'date'],
    ['timestamp with time zone', 'datetime'],
    ['timestamp', 'datetime'],
    ['time', 'datetime'],
    ['json', 'json'],
    ['jsonb', 'json'],
    ['integer', 'number'],
    ['bigint', 'number'],
    ['smallint', 'number'],
    ['numeric(12,2)', 'number'],
    ['double precision', 'number'],
    ['real', 'number'],
    ['text', 'text'],
    ['character varying', 'text'],
  ] as const)('maps %s to the %s widget', (dataType, widget) => {
    expect(scalarWidgetForDataType(dataType)).toBe(widget);
  });
});

describe('demoteUnpickableRelations', () => {
  it('demotes only the relation-select columns that have no picker config', () => {
    const table = makeTable('books', {
      columns: [
        makeColumn('id', { isPrimaryKey: true, dataType: 'uuid' }),
        makeColumn('author_id', {
          isForeignKey: true,
          widget: 'relation-select',
          dataType: 'uuid',
        }),
        makeColumn('edition_isbn', {
          isForeignKey: true,
          widget: 'relation-select',
          dataType: 'text',
        }),
        makeColumn('title', { dataType: 'text', widget: 'text' }),
      ],
    });
    // Only author_id has a usable picker config.
    const relations = [
      {
        field: 'author_id',
        resource: 'public.authors',
        labelField: 'display_name',
        searchFields: ['display_name'],
      },
    ];

    const demoted = demoteUnpickableRelations(table, relations);
    const byName = new Map(demoted.columns.map((c) => [c.name, c.widget]));

    expect(byName.get('author_id')).toBe('relation-select'); // pickable: kept
    expect(byName.get('edition_isbn')).toBe('text'); // unpickable: demoted
    expect(byName.get('title')).toBe('text'); // untouched
    // The source table is not mutated.
    expect(table.columns.find((c) => c.name === 'edition_isbn')?.widget).toBe(
      'relation-select',
    );
  });
});
