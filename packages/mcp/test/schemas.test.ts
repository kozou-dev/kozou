import { describe, it, expect } from 'vitest';
import {
  listTablesInputSchema,
  listTablesOutputSchema,
  describeTableInputSchema,
  describeTableOutputSchema,
  listViewsInputSchema,
  listViewsOutputSchema,
  describeViewInputSchema,
  describeViewOutputSchema,
  listConceptsInputSchema,
  listConceptsOutputSchema,
  getConceptContextInputSchema,
  getConceptContextOutputSchema,
  describeFunctionsInputSchema,
  describeFunctionsOutputSchema,
} from '../src/index.js';

describe('list_tables schemas', () => {
  it('input: empty object pass', () => {
    expect(() => listTablesInputSchema.parse({})).not.toThrow();
  });
  it('input: schema + includeSystem pass', () => {
    expect(() =>
      listTablesInputSchema.parse({ schema: 'public', includeSystem: false }),
    ).not.toThrow();
  });
  it('input: invalid type throw', () => {
    expect(() => listTablesInputSchema.parse({ schema: 123 })).toThrow();
  });
  it('output: valid pass', () => {
    expect(() =>
      listTablesOutputSchema.parse({
        tables: [
          {
            qualifiedName: 'public.a',
            label: 'A',
            description: null,
            rowCountEstimate: null,
          },
        ],
      }),
    ).not.toThrow();
  });
  it('output: missing field throw', () => {
    expect(() =>
      listTablesOutputSchema.parse({ tables: [{ qualifiedName: 'a' }] }),
    ).toThrow();
  });
});

describe('describe_table schemas', () => {
  it('input: valid pass', () => {
    expect(() =>
      describeTableInputSchema.parse({ qualifiedName: 'public.a' }),
    ).not.toThrow();
  });
  it('input: empty string throw (min 1)', () => {
    expect(() => describeTableInputSchema.parse({ qualifiedName: '' })).toThrow();
  });
  it('input: missing qualifiedName throw', () => {
    expect(() => describeTableInputSchema.parse({})).toThrow();
  });
  it('output: minimal valid pass', () => {
    expect(() =>
      describeTableOutputSchema.parse({
        qualifiedName: 'public.a',
        label: 'A',
        description: null,
        aiDescription: null,
        policy: [],
        primaryKey: ['id'],
        columns: [],
        relations: [],
        checkConstraints: [],
      }),
    ).not.toThrow();
  });
  it('output: full valid (column + relation + check + references)', () => {
    expect(() =>
      describeTableOutputSchema.parse({
        qualifiedName: 'public.a',
        label: 'A',
        description: 'desc',
        aiDescription: 'ai',
        policy: ['status may not change in production'],
        primaryKey: ['id'],
        columns: [
          {
            name: 'id',
            dataType: 'uuid',
            nullable: false,
            defaultExpr: null,
            description: null,
            aiDescription: null,
            policy: [],
            enumValues: null,
            isForeignKey: false,
            references: null,
          },
          {
            name: 'parent_id',
            dataType: 'uuid',
            nullable: true,
            defaultExpr: null,
            description: 'parent',
            aiDescription: null,
            policy: ['only support may reassign the parent'],
            enumValues: null,
            isForeignKey: true,
            references: { table: 'public.parents', column: 'id' },
          },
        ],
        relations: [
          {
            field: 'parent_id',
            fields: ['parent_id'],
            referencesTable: 'public.parents',
            referencesColumn: 'id',
            referencesColumns: ['id'],
            meaning: null,
          },
        ],
        checkConstraints: [{ name: 'a_check', expression: 'id IS NOT NULL' }],
      }),
    ).not.toThrow();
  });
});

describe('list_views schemas', () => {
  it('input: empty pass', () => {
    expect(() => listViewsInputSchema.parse({})).not.toThrow();
  });
  it('input: schema pass', () => {
    expect(() => listViewsInputSchema.parse({ schema: 'public' })).not.toThrow();
  });
  it('output: valid pass', () => {
    expect(() =>
      listViewsOutputSchema.parse({
        views: [{ qualifiedName: 'public.v', label: 'V', purpose: 'p' }],
      }),
    ).not.toThrow();
  });
  it('output: null purpose pass', () => {
    expect(() =>
      listViewsOutputSchema.parse({
        views: [{ qualifiedName: 'public.v', label: 'V', purpose: null }],
      }),
    ).not.toThrow();
  });
});

describe('describe_view schemas', () => {
  it('input: valid pass', () => {
    expect(() =>
      describeViewInputSchema.parse({ qualifiedName: 'public.v' }),
    ).not.toThrow();
  });
  it('input: empty string throw', () => {
    expect(() => describeViewInputSchema.parse({ qualifiedName: '' })).toThrow();
  });
  it('output: valid pass', () => {
    expect(() =>
      describeViewOutputSchema.parse({
        qualifiedName: 'public.v',
        label: 'V',
        description: null,
        aiDescription: null,
        policy: [],
        columns: [],
        underlyingTables: ['public.a', 'public.b'],
        definition: 'SELECT 1',
      }),
    ).not.toThrow();
  });
  it('output: missing policy throws (field is required)', () => {
    expect(() =>
      describeViewOutputSchema.parse({
        qualifiedName: 'public.v',
        label: 'V',
        description: null,
        aiDescription: null,
        columns: [],
        underlyingTables: [],
        definition: 'SELECT 1',
      }),
    ).toThrow();
  });
});

describe('list_concepts schemas', () => {
  it('input: empty object pass', () => {
    expect(() => listConceptsInputSchema.parse({})).not.toThrow();
  });
  it('input: rejects extra fields (strict)', () => {
    expect(() => listConceptsInputSchema.parse({ foo: 'bar' })).toThrow();
  });
  it('output: valid pass', () => {
    expect(() =>
      listConceptsOutputSchema.parse({
        concepts: [
          {
            name: 'vw_x',
            label: 'X',
            description: null,
            kind: 'VIEW',
          },
        ],
      }),
    ).not.toThrow();
  });
  it('output: throws when kind is not VIEW', () => {
    expect(() =>
      listConceptsOutputSchema.parse({
        concepts: [{ name: 'x', label: 'X', description: null, kind: 'FUNCTION' }],
      }),
    ).toThrow();
  });
});

describe('get_concept_context schemas', () => {
  it('input: valid pass', () => {
    expect(() => getConceptContextInputSchema.parse({ name: 'vw_x' })).not.toThrow();
  });
  it('input: empty string throw', () => {
    expect(() => getConceptContextInputSchema.parse({ name: '' })).toThrow();
  });
  it('output: valid pass', () => {
    expect(() =>
      getConceptContextOutputSchema.parse({
        name: 'vw_x',
        label: 'X',
        description: 'desc',
        aiNotes: ['n1', 'n2'],
        policies: ['internal use only'],
        preferredQuerySource: 'FROM vw_x',
        joinSuggestions: [
          { table: 'public.a', on: 'vw_x.a_id = a.id', purpose: 'p' },
        ],
        relatedTables: ['public.a'],
        exampleQueries: [{ description: 'd', sql: 'SELECT 1' }],
      }),
    ).not.toThrow();
  });
  it('output: empty exampleQueries pass', () => {
    expect(() =>
      getConceptContextOutputSchema.parse({
        name: 'x',
        label: 'X',
        description: null,
        aiNotes: [],
        policies: [],
        preferredQuerySource: 'FROM x',
        joinSuggestions: [],
        relatedTables: [],
        exampleQueries: [],
      }),
    ).not.toThrow();
  });
});

describe('describe_functions schemas', () => {
  it('input: empty object pass', () => {
    expect(() => describeFunctionsInputSchema.parse({})).not.toThrow();
  });
  it('input: rejects extra fields (strict)', () => {
    expect(() => describeFunctionsInputSchema.parse({ foo: 'bar' })).toThrow();
  });
  it('output: valid pass', () => {
    expect(() =>
      describeFunctionsOutputSchema.parse({
        functions: [
          {
            qualifiedName: 'public.approve_order',
            label: 'Approve an order',
            description: 'desc',
            aiDescription: 'not idempotent',
            policy: ['managers only'],
            volatility: 'volatile',
            security: 'invoker',
            publicCallable: false,
            args: [
              {
                name: 'order_id',
                typeName: 'uuid',
                hasDefault: false,
                enumValues: null,
                relation: 'public.orders.id',
                widget: 'relation-select',
              },
            ],
            returns: { kind: 'scalar', typeName: 'integer', columns: null },
          },
        ],
      }),
    ).not.toThrow();
  });
  it('output: throws on an unknown return kind', () => {
    expect(() =>
      describeFunctionsOutputSchema.parse({
        functions: [
          {
            qualifiedName: 'public.f',
            label: 'f',
            description: null,
            aiDescription: null,
            policy: [],
            volatility: 'stable',
            security: 'definer',
            publicCallable: true,
            args: [],
            returns: { kind: 'table', typeName: 'x', columns: null },
          },
        ],
      }),
    ).toThrow();
  });
});
