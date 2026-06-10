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
          fields: ['author_id'],
          references: { schema: 'public', table: 'authors', column: 'id', columns: ['id'] },
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
          fields: ['author_id'],
          references: { schema: 'public', table: 'authors', column: 'id', columns: ['id'] },
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
          fields: ['author_id'],
          references: { schema: 'public', table: 'authors', column: 'id', columns: ['id'] },
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
          fields: ['author_id'],
          references: { schema: 'public', table: 'authors', column: 'id', columns: ['id'] },
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
          fields: ['author_id'],
          references: { schema: 'public', table: 'authors', column: 'id', columns: ['id'] },
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
          fields: ['author_id'],
          references: { schema: 'public', table: 'authors', column: 'id', columns: ['id'] },
          cardinality: 'many-to-one',
          meaning: null,
        },
        {
          field: 'edition_id',
          fields: ['edition_id'],
          references: { schema: 'public', table: 'editions', column: 'id', columns: ['id'] },
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

  it('resolves a composite relation through the target primary key', async () => {
    const orderLines = makeTable('order_lines', {
      displayField: 'summary',
      primaryKey: ['order_id', 'line_no'],
      columns: [
        makeColumn('order_id', { isPrimaryKey: true }),
        makeColumn('line_no', { isPrimaryKey: true, dataType: 'integer' }),
        makeColumn('summary', { dataType: 'text' }),
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
    const schema = makeSchema([orderLines, shipments]);
    const loadRow = vi.fn(async (qn, id) => {
      if (qn === 'public.order_lines' && Array.isArray(id) && id[0] === 'o1' && id[1] === 2) {
        return { order_id: 'o1', line_no: 2, summary: 'Bulk paper' };
      }
      return null;
    });

    const result = await resolveFkLabels({
      table: shipments,
      row: { id: 's1', order_id: 'o1', line_no: 2 },
      schema,
      loadRow,
    });

    // Keyed by the relation's first column; `value` is the encoded id
    // segment ready for the detail link.
    expect(result).toEqual({
      order_id: {
        value: 'o1,2',
        label: 'Bulk paper',
        referencedQualifiedName: 'public.order_lines',
      },
    });
    expect(loadRow).toHaveBeenCalledWith('public.order_lines', ['o1', 2]);
  });

  it('orders composite id components by the target primary key, not the referencing columns', async () => {
    const orderLines = makeTable('order_lines', {
      displayField: 'summary',
      primaryKey: ['order_id', 'line_no'],
      columns: [
        makeColumn('order_id', { isPrimaryKey: true }),
        makeColumn('line_no', { isPrimaryKey: true, dataType: 'integer' }),
        makeColumn('summary', { dataType: 'text' }),
      ],
    });
    const shipments = makeTable('shipments', {
      relations: [
        {
          // The foreign key lists the referenced columns in reverse order.
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
    const schema = makeSchema([orderLines, shipments]);
    const loadRow = vi.fn(async () => ({ order_id: 'o1', line_no: 2, summary: 'Bulk paper' }));

    const result = await resolveFkLabels({
      table: shipments,
      row: { id: 's1', src_order: 'o1', src_line: 2 },
      schema,
      loadRow,
    });

    expect(loadRow).toHaveBeenCalledWith('public.order_lines', ['o1', 2]);
    expect(result.src_line).toEqual({
      value: 'o1,2',
      label: 'Bulk paper',
      referencedQualifiedName: 'public.order_lines',
    });
  });

  it('skips a composite relation when a component is null', async () => {
    const orderLines = makeTable('order_lines', {
      displayField: 'summary',
      primaryKey: ['order_id', 'line_no'],
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
    const schema = makeSchema([orderLines, shipments]);
    const loadRow = vi.fn();

    const result = await resolveFkLabels({
      table: shipments,
      row: { id: 's1', order_id: 'o1', line_no: null },
      schema,
      loadRow,
    });

    expect(result).toEqual({});
    expect(loadRow).not.toHaveBeenCalled();
  });

  it('skips a composite relation that does not reference the target primary key', async () => {
    // The target's primary key is a surrogate id; the relation references a
    // composite unique constraint instead, so the row cannot be fetched by id.
    const orderLines = makeTable('order_lines', {
      displayField: 'summary',
      primaryKey: ['id'],
      columns: [
        makeColumn('id', { isPrimaryKey: true }),
        makeColumn('order_id'),
        makeColumn('line_no', { dataType: 'integer' }),
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
    const schema = makeSchema([orderLines, shipments]);
    const loadRow = vi.fn();

    const result = await resolveFkLabels({
      table: shipments,
      row: { id: 's1', order_id: 'o1', line_no: 2 },
      schema,
      loadRow,
    });

    expect(result).toEqual({});
    expect(loadRow).not.toHaveBeenCalled();
  });

  it('still resolves a legacy scalar-only relation object (no fields array)', async () => {
    const authors = makeTable('authors', { displayField: 'display_name' });
    const books = makeTable('books', {
      relations: [
        {
          field: 'author_id',
          references: { schema: 'public', table: 'authors', column: 'id' },
          cardinality: 'many-to-one',
          meaning: null,
        } as TableContext['relations'][number],
      ],
    });
    const schema = makeSchema([authors, books]);
    const loadRow = vi.fn(async () => ({ id: 'a1', display_name: 'Margaret Atwood' }));

    const result = await resolveFkLabels({
      table: books,
      row: { id: 'b1', author_id: 'a1' },
      schema,
      loadRow,
    });

    expect(result.author_id?.label).toBe('Margaret Atwood');
  });

  it('skips composite relations that share their first column (no nondeterministic overwrite)', async () => {
    const orders = makeTable('orders', {
      displayField: 'order_no',
      primaryKey: ['tenant_id', 'order_id'],
    });
    const products = makeTable('products', {
      displayField: 'sku',
      primaryKey: ['tenant_id', 'product_id'],
    });
    const shipments = makeTable('shipments', {
      relations: [
        {
          field: 'tenant_id',
          fields: ['tenant_id', 'order_id'],
          references: {
            schema: 'public',
            table: 'orders',
            column: 'tenant_id',
            columns: ['tenant_id', 'order_id'],
          },
          cardinality: 'many-to-one',
          meaning: null,
        },
        {
          field: 'tenant_id',
          fields: ['tenant_id', 'product_id'],
          references: {
            schema: 'public',
            table: 'products',
            column: 'tenant_id',
            columns: ['tenant_id', 'product_id'],
          },
          cardinality: 'many-to-one',
          meaning: null,
        },
      ],
    });
    const schema = makeSchema([orders, products, shipments]);
    const loadRow = vi.fn();

    const result = await resolveFkLabels({
      table: shipments,
      row: { id: 's1', tenant_id: 't1', order_id: 'o1', product_id: 'p1' },
      schema,
      loadRow,
    });

    expect(result).toEqual({});
    expect(loadRow).not.toHaveBeenCalled();
  });

  it('lets a single-column relation win over a composite sharing its first column', async () => {
    const tenants = makeTable('tenants', { displayField: 'name' });
    const orders = makeTable('orders', {
      displayField: 'order_no',
      primaryKey: ['tenant_id', 'order_id'],
    });
    const shipments = makeTable('shipments', {
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
          fields: ['tenant_id', 'order_id'],
          references: {
            schema: 'public',
            table: 'orders',
            column: 'tenant_id',
            columns: ['tenant_id', 'order_id'],
          },
          cardinality: 'many-to-one',
          meaning: null,
        },
      ],
    });
    const schema = makeSchema([tenants, orders, shipments]);
    const loadRow = vi.fn(async (qn) =>
      qn === 'public.tenants' ? { id: 't1', name: 'Acme' } : null,
    );

    const result = await resolveFkLabels({
      table: shipments,
      row: { id: 's1', tenant_id: 't1', order_id: 'o1' },
      schema,
      loadRow,
    });

    // The composite relation is skipped; the single FK resolves as before.
    expect(loadRow).toHaveBeenCalledTimes(1);
    expect(loadRow).toHaveBeenCalledWith('public.tenants', 't1');
    expect(result.tenant_id?.label).toBe('Acme');
  });
});
