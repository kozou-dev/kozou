import { describe, expect, it, vi } from 'vitest';

import type {
  ColumnContext,
  RelationOption,
  SchemaContext,
  TableContext,
} from '@kozou/core';

import type { RelationFieldConfig } from '../../src/lib/form/relation-field-config.js';
import {
  ensureSelectedOptions,
  loadInitialRelationOptions,
  searchRelationOptions,
} from '../../src/lib/server/relation-options.js';

function makeColumn(
  name: string,
  overrides: Partial<ColumnContext> = {},
): ColumnContext {
  return {
    name,
    dataType: 'text',
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

function makeSchema(): SchemaContext {
  const authors: TableContext = {
    schema: 'public',
    name: 'authors',
    qualifiedName: 'public.authors',
    label: 'authors',
    description: null,
    aiDescription: null,
    primaryKey: ['id'],
    displayField: 'display_name',
    columns: [
      makeColumn('id', { isPrimaryKey: true, dataType: 'uuid' }),
      makeColumn('display_name'),
    ],
    relations: [],
    rawTable: {} as TableContext['rawTable'],
  };
  return {
    meta: {
      serverVersion: 'test',
      builtAt: '2026-06-10T00:00:00Z',
      sourceSchemas: ['public'],
    },
    tables: [authors],
    views: [],
    enums: [],
    concepts: [],
  };
}

const authorRelation: RelationFieldConfig = {
  field: 'author_id',
  resource: 'public.authors',
  labelField: 'display_name',
  searchFields: ['display_name'],
};

describe('loadInitialRelationOptions', () => {
  it('fetches the first page for each relation and keys it by field', async () => {
    const editionRelation: RelationFieldConfig = {
      field: 'edition_id',
      resource: 'public.editions',
      labelField: 'isbn',
      searchFields: ['isbn'],
    };
    const searchRelation = vi.fn(async (resource: string) =>
      resource === 'public.authors'
        ? [{ id: 'a1', label: 'Margaret Atwood' }]
        : [{ id: 'e1', label: '978-...' }],
    );

    const result = await loadInitialRelationOptions({ searchRelation }, [
      authorRelation,
      editionRelation,
    ]);

    expect(result).toEqual({
      author_id: [{ id: 'a1', label: 'Margaret Atwood' }],
      edition_id: [{ id: 'e1', label: '978-...' }],
    });
    expect(searchRelation).toHaveBeenCalledWith('public.authors', {
      query: '',
      labelField: 'display_name',
      searchFields: ['display_name'],
      limit: 20,
    });
  });

  it('degrades a failing relation to an empty list without breaking the others', async () => {
    const editionRelation: RelationFieldConfig = {
      field: 'edition_id',
      resource: 'public.editions',
      labelField: 'isbn',
      searchFields: ['isbn'],
    };
    const searchRelation = vi.fn(async (resource: string) => {
      if (resource === 'public.editions') throw new Error('backend down');
      return [{ id: 'a1', label: 'Margaret Atwood' }];
    });

    const result = await loadInitialRelationOptions({ searchRelation }, [
      authorRelation,
      editionRelation,
    ]);

    expect(result).toEqual({
      author_id: [{ id: 'a1', label: 'Margaret Atwood' }],
      edition_id: [],
    });
  });

  it('returns an empty map when there are no relations', async () => {
    const searchRelation = vi.fn();
    expect(await loadInitialRelationOptions({ searchRelation }, [])).toEqual({});
    expect(searchRelation).not.toHaveBeenCalled();
  });
});

describe('ensureSelectedOptions', () => {
  function optionsFor(rows: RelationOption[]): Record<string, RelationOption[]> {
    return { author_id: rows };
  }

  it('prepends the current value with a resolved label when missing from the page', async () => {
    const get = vi.fn(async () => ({ id: 'a9', display_name: 'Octavia Butler' }));
    const options = optionsFor([{ id: 'a1', label: 'Margaret Atwood' }]);

    await ensureSelectedOptions(
      { get },
      [authorRelation],
      { author_id: 'a9' },
      options,
    );

    expect(options.author_id).toEqual([
      { id: 'a9', label: 'Octavia Butler' },
      { id: 'a1', label: 'Margaret Atwood' },
    ]);
    expect(get).toHaveBeenCalledWith('public.authors', 'a9');
  });

  it('does nothing when the current value is already in the page', async () => {
    const get = vi.fn();
    const options = optionsFor([{ id: 'a9', label: 'Octavia Butler' }]);

    await ensureSelectedOptions(
      { get },
      [authorRelation],
      { author_id: 'a9' },
      options,
    );

    expect(options.author_id).toEqual([{ id: 'a9', label: 'Octavia Butler' }]);
    expect(get).not.toHaveBeenCalled();
  });

  it('skips a null / undefined / non-scalar current value', async () => {
    const get = vi.fn();
    const options = optionsFor([]);

    await ensureSelectedOptions({ get }, [authorRelation], { author_id: null }, options);
    await ensureSelectedOptions({ get }, [authorRelation], {}, options);
    await ensureSelectedOptions(
      { get },
      [authorRelation],
      { author_id: { nested: true } },
      options,
    );

    expect(options.author_id).toEqual([]);
    expect(get).not.toHaveBeenCalled();
  });

  it('falls back to the raw value as its own label when the target lookup fails', async () => {
    const get = vi.fn(async () => {
      throw new Error('not found');
    });
    const options = optionsFor([]);

    await ensureSelectedOptions(
      { get },
      [authorRelation],
      { author_id: 'a9' },
      options,
    );

    expect(options.author_id).toEqual([{ id: 'a9', label: 'a9' }]);
  });

  it('uses the raw value when the target row lacks the label column', async () => {
    const get = vi.fn(async () => ({ id: 'a9', display_name: null }));
    const options = optionsFor([]);

    await ensureSelectedOptions(
      { get },
      [authorRelation],
      { author_id: 'a9' },
      options,
    );

    expect(options.author_id).toEqual([{ id: 'a9', label: 'a9' }]);
  });

  it('seeds a field that had no initial options entry', async () => {
    const get = vi.fn(async () => ({ id: 'a9', display_name: 'Octavia Butler' }));
    const options: Record<string, RelationOption[]> = {};

    await ensureSelectedOptions(
      { get },
      [authorRelation],
      { author_id: 'a9' },
      options,
    );

    expect(options.author_id).toEqual([{ id: 'a9', label: 'Octavia Butler' }]);
  });
});

describe('searchRelationOptions', () => {
  function adapterReturning(options: RelationOption[]) {
    return { searchRelation: vi.fn(async () => options) };
  }

  it('forwards a valid request to the adapter and returns the options', async () => {
    const adapter = adapterReturning([{ id: 'a1', label: 'Margaret Atwood' }]);
    const result = await searchRelationOptions(makeSchema(), adapter, {
      resource: 'public.authors',
      label: 'display_name',
      fields: 'display_name',
      query: 'atw',
      limit: '5',
    });

    expect(result).toEqual([{ id: 'a1', label: 'Margaret Atwood' }]);
    expect(adapter.searchRelation).toHaveBeenCalledWith('public.authors', {
      query: 'atw',
      labelField: 'display_name',
      searchFields: ['display_name'],
      limit: 5,
    });
  });

  it('defaults query / search fields / limit when absent', async () => {
    const adapter = adapterReturning([]);
    await searchRelationOptions(makeSchema(), adapter, {
      resource: 'public.authors',
      label: 'display_name',
      fields: null,
      query: null,
      limit: null,
    });

    expect(adapter.searchRelation).toHaveBeenCalledWith('public.authors', {
      query: '',
      labelField: 'display_name',
      searchFields: [],
      limit: 20,
    });
  });

  it('clamps an oversized limit to the maximum', async () => {
    const adapter = adapterReturning([]);
    await searchRelationOptions(makeSchema(), adapter, {
      resource: 'public.authors',
      label: 'display_name',
      fields: null,
      query: null,
      limit: '9999',
    });

    expect(adapter.searchRelation).toHaveBeenCalledWith(
      'public.authors',
      expect.objectContaining({ limit: 100 }),
    );
  });

  it('rejects a missing resource or label with 400', async () => {
    const adapter = adapterReturning([]);
    await expect(
      searchRelationOptions(makeSchema(), adapter, {
        resource: null,
        label: 'display_name',
        fields: null,
        query: null,
        limit: null,
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      searchRelationOptions(makeSchema(), adapter, {
        resource: 'public.authors',
        label: '',
        fields: null,
        query: null,
        limit: null,
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(adapter.searchRelation).not.toHaveBeenCalled();
  });

  it('rejects an unknown target table with 404', async () => {
    const adapter = adapterReturning([]);
    await expect(
      searchRelationOptions(makeSchema(), adapter, {
        resource: 'public.ghosts',
        label: 'display_name',
        fields: null,
        query: null,
        limit: null,
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(adapter.searchRelation).not.toHaveBeenCalled();
  });

  it('rejects a label or search field that is not a column of the target', async () => {
    const adapter = adapterReturning([]);
    await expect(
      searchRelationOptions(makeSchema(), adapter, {
        resource: 'public.authors',
        label: 'secret',
        fields: null,
        query: null,
        limit: null,
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      searchRelationOptions(makeSchema(), adapter, {
        resource: 'public.authors',
        label: 'display_name',
        fields: 'display_name,secret',
        query: null,
        limit: null,
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(adapter.searchRelation).not.toHaveBeenCalled();
  });
});
