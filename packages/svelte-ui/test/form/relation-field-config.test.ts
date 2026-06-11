import { describe, expect, it } from 'vitest';

import type { ColumnContext, SchemaContext, TableContext } from '@kozou/core';

import {
  demoteUnpickableRelations,
  isPickableOption,
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

  it('maps a composite foreign key to one picker config with key-ordered fields', () => {
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
    ).toEqual([
      {
        field: 'order_id',
        fields: ['order_id', 'line_no'],
        keyFields: ['order_id', 'line_no'],
        resource: 'public.order_lines',
        labelField: 'product',
        searchFields: ['product'],
      },
    ]);
  });

  it('reorders keyFields when the foreign key lists the key columns permuted', () => {
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
          // FK declaration order is reversed relative to the target key.
          field: 'src_line',
          fields: ['src_line', 'src_order'],
          references: {
            schema: 'public',
            table: 'order_lines',
            column: 'line_no',
            columns: ['line_no', 'order_id'],
          },
          cardinality: 'many-to-one',
          meaning: null,
        },
      ],
    });

    const configs = relationFieldConfigs(
      shipments,
      makeSchema([target, shipments]),
    );
    // keyFields follow the TARGET key order (order_id, line_no), so option-id
    // components fan out positionally.
    expect(configs[0]?.keyFields).toEqual(['src_order', 'src_line']);
    expect(configs[0]?.fields).toEqual(['src_line', 'src_order']);
  });

  it('skips a composite relation that does not cover the target primary key', () => {
    const target = makeTable('order_lines', {
      primaryKey: ['id'],
      displayField: 'product',
      columns: [
        makeColumn('id', { isPrimaryKey: true }),
        makeColumn('order_id', { dataType: 'integer' }),
        makeColumn('line_no', { dataType: 'integer' }),
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

  it('skips a composite relation whose label column is not text-searchable', () => {
    const target = makeTable('order_lines', {
      primaryKey: ['order_id', 'line_no'],
      // No display column: the fallback label is the first key column, an
      // integer — not searchable, so the picker would strand values.
      displayField: 'order_id',
      columns: [
        makeColumn('order_id', { isPrimaryKey: true, dataType: 'integer' }),
        makeColumn('line_no', { isPrimaryKey: true, dataType: 'integer' }),
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

  it('drops composite configs whose columns collide with another picker', () => {
    const orders = makeTable('orders', {
      primaryKey: ['tenant_id', 'order_no'],
      displayField: 'title',
      columns: [
        makeColumn('tenant_id', { isPrimaryKey: true }),
        makeColumn('order_no', { isPrimaryKey: true, dataType: 'integer' }),
        makeColumn('title', { dataType: 'text' }),
      ],
    });
    const products = makeTable('products', {
      primaryKey: ['tenant_id', 'sku'],
      displayField: 'name',
      columns: [
        makeColumn('tenant_id', { isPrimaryKey: true }),
        makeColumn('sku', { isPrimaryKey: true, dataType: 'text' }),
        makeColumn('name', { dataType: 'text' }),
      ],
    });
    const shipments = makeTable('shipments', {
      relations: [
        {
          field: 'tenant_id',
          fields: ['tenant_id', 'order_no'],
          references: {
            schema: 'public',
            table: 'orders',
            column: 'tenant_id',
            columns: ['tenant_id', 'order_no'],
          },
          cardinality: 'many-to-one',
          meaning: null,
        },
        {
          field: 'tenant_id',
          fields: ['tenant_id', 'sku'],
          references: {
            schema: 'public',
            table: 'products',
            column: 'tenant_id',
            columns: ['tenant_id', 'sku'],
          },
          cardinality: 'many-to-one',
          meaning: null,
        },
      ],
    });

    // Both composite pickers would write tenant_id; writing it from two
    // pickers would race, so both are dropped (scalar inputs remain).
    expect(
      relationFieldConfigs(shipments, makeSchema([orders, products, shipments])),
    ).toEqual([]);
  });

  it('keeps a single-column picker when a composite sharing its column is dropped', () => {
    const tenants = makeTable('tenants', {
      displayField: 'name',
      columns: [
        makeColumn('id', { isPrimaryKey: true }),
        makeColumn('name', { dataType: 'text' }),
      ],
    });
    const orders = makeTable('orders', {
      primaryKey: ['tenant_id', 'order_no'],
      displayField: 'title',
      columns: [
        makeColumn('tenant_id', { isPrimaryKey: true }),
        makeColumn('order_no', { isPrimaryKey: true, dataType: 'integer' }),
        makeColumn('title', { dataType: 'text' }),
      ],
    });
    const shipments = makeTable('shipments', {
      columns: [
        makeColumn('id', { isPrimaryKey: true }),
        makeColumn('tenant_id', {
          isForeignKey: true,
          widget: 'relation-select',
        }),
        makeColumn('order_no', { dataType: 'integer' }),
      ],
      relations: [
        {
          field: 'tenant_id',
          fields: ['tenant_id'],
          references: { schema: 'public', table: 'tenants', column: 'id', columns: ['id'] },
          cardinality: 'many-to-one',
          meaning: null,
        },
        {
          field: 'tenant_id',
          fields: ['tenant_id', 'order_no'],
          references: {
            schema: 'public',
            table: 'orders',
            column: 'tenant_id',
            columns: ['tenant_id', 'order_no'],
          },
          cardinality: 'many-to-one',
          meaning: null,
        },
      ],
    });

    const configs = relationFieldConfigs(
      shipments,
      makeSchema([tenants, orders, shipments]),
    );
    expect(configs).toHaveLength(1);
    expect(configs[0]?.resource).toBe('public.tenants');
    expect(configs[0]?.fields).toBeUndefined();
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

describe('relationFieldConfigs — ownership against non-picker relations', () => {
  it('drops a composite whose column is shared with an unpickable relation', () => {
    const orders = makeTable('orders', {
      primaryKey: ['tenant_id', 'order_no'],
      displayField: 'title',
      columns: [
        makeColumn('tenant_id', { isPrimaryKey: true }),
        makeColumn('order_no', { isPrimaryKey: true, dataType: 'integer' }),
        makeColumn('title', { dataType: 'text' }),
      ],
    });
    const shipments = makeTable('shipments', {
      relations: [
        {
          field: 'tenant_id',
          fields: ['tenant_id', 'order_no'],
          references: {
            schema: 'public',
            table: 'orders',
            column: 'tenant_id',
            columns: ['tenant_id', 'order_no'],
          },
          cardinality: 'many-to-one',
          meaning: null,
        },
        {
          // Shares tenant_id but is NOT picker-eligible (its target table is
          // absent from the schema). Rewriting tenant_id from the picker
          // would leave this relation's other component stale.
          field: 'tenant_id',
          fields: ['tenant_id', 'region'],
          references: {
            schema: 'public',
            table: 'tenancy_regions',
            column: 'tenant_id',
            columns: ['tenant_id', 'region'],
          },
          cardinality: 'many-to-one',
          meaning: null,
        },
      ],
    });

    expect(
      relationFieldConfigs(shipments, makeSchema([orders, shipments])),
    ).toEqual([]);
  });
});

describe('isPickableOption', () => {
  it('accepts normal scalar and composite ids', () => {
    expect(isPickableOption({ id: 'a1', label: 'A' })).toBe(true);
    expect(isPickableOption({ id: 0, label: 'zero' })).toBe(true);
    expect(isPickableOption({ id: ['o1', 2], label: 'line' })).toBe(true);
  });

  it("rejects ids containing an empty-string component (the '' sentinel)", () => {
    expect(isPickableOption({ id: '', label: 'empty' })).toBe(false);
    expect(isPickableOption({ id: ['A', ''], label: 'partial' })).toBe(false);
  });
});
