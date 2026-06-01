import { describe, it, expect } from 'vitest';
import type { WidgetType } from '@kozou/core';
import { buildOpenApiDocument } from '../src/openapi.js';
import { schemaOf, col, relation } from './helpers.js';

type SchemaObj = {
  type?: unknown;
  format?: string;
  enum?: unknown[];
  description?: string;
  required?: string[];
  properties?: Record<string, SchemaObj>;
  'x-kozou-ai'?: string;
  'x-kozou-policy'?: string[];
  'x-kozou-widget'?: string;
};
type Doc = {
  openapi: string;
  info: { title: string; version: string; description: string };
  paths: Record<string, Record<string, unknown>>;
  components: { schemas: Record<string, SchemaObj> };
};

function build(): Doc {
  const schema = schemaOf(
    [
      {
        name: 'authors',
        description: 'Authors of books.',
        policy: ['only owners may delete an author'],
        columns: [
          col('id', 'uuid', { isPrimaryKey: true, nullable: false }),
          col('display_name', 'text', { nullable: false, description: 'Display name.' }),
          col('status', 'enum-select', {
            nullable: false,
            enumValues: ['a', 'b'],
            policy: ['only support may set it to b'],
          }),
          col('bio', 'textarea', { nullable: true, aiDescription: 'free text' }),
          col('price', 'currency', { nullable: true }),
        ],
        primaryKey: ['id'],
      },
    ],
    [
      {
        name: 'vw_active',
        description: 'Active authors.',
        aiDescription: 'start here for active authors',
        policy: ['internal use only'],
        columns: [col('id', 'uuid'), col('label', 'text')],
      },
    ],
  );
  return buildOpenApiDocument(schema, { version: '1.2.3' }) as unknown as Doc;
}

describe('buildOpenApiDocument', () => {
  it('emits an OpenAPI 3.1 envelope with the configured version', () => {
    const doc = build();
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.version).toBe('1.2.3');
    expect(doc.info.title).toBe('Kozou API');
  });

  it('exposes full CRUD paths for tables and read-only paths for views', () => {
    const doc = build();
    expect(doc.paths['/authors'].get).toBeDefined();
    expect(doc.paths['/authors'].post).toBeDefined();
    expect(doc.paths['/authors/{id}'].get).toBeDefined();
    expect(doc.paths['/authors/{id}'].patch).toBeDefined();
    expect(doc.paths['/authors/{id}'].delete).toBeDefined();

    expect(doc.paths['/vw_active'].get).toBeDefined();
    expect(doc.paths['/vw_active'].post).toBeUndefined();
    expect(doc.paths['/vw_active/{id}'].patch).toBeUndefined();
    expect(doc.paths['/vw_active/{id}'].delete).toBeUndefined();
  });

  it('reflects table COMMENTs into the component schema', () => {
    const authors = build().components.schemas['public.authors'];
    expect(authors.description).toBe('Authors of books.');
    expect(authors.required).toEqual(expect.arrayContaining(['id', 'display_name', 'status']));
    expect(authors.required).not.toContain('bio');
  });

  it('maps widgets, enums, nullability, and AI notes onto column schemas', () => {
    const props = build().components.schemas['public.authors'].properties!;
    expect(props.id.type).toBe('string');
    expect(props.id.format).toBe('uuid');
    expect(props.id['x-kozou-widget']).toBe('uuid');

    expect(props.display_name.description).toBe('Display name.');

    expect(props.status.enum).toEqual(['a', 'b']);
    expect(props.status['x-kozou-widget']).toBe('enum-select');

    // nullable -> JSON Schema type union including "null"
    expect(props.bio.type).toEqual(['string', 'null']);
    expect(props.bio['x-kozou-ai']).toBe('free text');

    expect(props.price.type).toEqual(['number', 'null']);
  });

  it('carries the view @ai note as x-kozou-ai', () => {
    const vw = build().components.schemas['public.vw_active'];
    expect(vw['x-kozou-ai']).toBe('start here for active authors');
  });

  it('reflects @policy: rules as x-kozou-policy on tables, columns, and views', () => {
    const doc = build();
    const authors = doc.components.schemas['public.authors'];
    expect(authors['x-kozou-policy']).toEqual(['only owners may delete an author']);
    expect(authors.properties!.status['x-kozou-policy']).toEqual(['only support may set it to b']);
    // A column with no @policy: carries no x-kozou-policy key.
    expect(authors.properties!.display_name['x-kozou-policy']).toBeUndefined();

    expect(doc.components.schemas['public.vw_active']['x-kozou-policy']).toEqual([
      'internal use only',
    ]);
  });

  it('wires list responses to the row component via $ref', () => {
    const doc = build();
    expect(JSON.stringify(doc.paths['/authors'])).toContain(
      '#/components/schemas/public.authors',
    );
  });

  it('maps every widget type to a JSON Schema type/format', () => {
    const widgets: WidgetType[] = [
      'text',
      'textarea',
      'number',
      'boolean',
      'date',
      'datetime',
      'enum-select',
      'relation-select',
      'json',
      'image-url',
      'uuid',
      'currency',
    ];
    const schema = schemaOf([
      { name: 't', columns: widgets.map((w) => col(`c_${w.replaceAll('-', '_')}`, w, { nullable: false })) },
    ]);
    const props = (buildOpenApiDocument(schema) as unknown as Doc).components.schemas['public.t']
      .properties!;
    expect(props.c_text.type).toBe('string');
    expect(props.c_number.type).toBe('number');
    expect(props.c_currency.type).toBe('number');
    expect(props.c_boolean.type).toBe('boolean');
    expect(props.c_date).toMatchObject({ type: 'string', format: 'date' });
    expect(props.c_datetime).toMatchObject({ type: 'string', format: 'date-time' });
    expect(props.c_uuid).toMatchObject({ type: 'string', format: 'uuid' });
    expect(props.c_image_url).toMatchObject({ type: 'string', format: 'uri' });
    expect(props.c_json.type).toBe('object');
    expect(props.c_relation_select.type).toBe('string');
  });

  it('exposes an embed query parameter on the collection and item GETs', () => {
    const doc = build();
    const names = (get: unknown): string[] =>
      ((get as { parameters?: { name: string }[] }).parameters ?? []).map((p) => p.name);
    expect(names(doc.paths['/authors'].get)).toContain('embed');
    expect(names(doc.paths['/authors/{id}'].get)).toContain('embed');
  });

  it('lists embeddable relations as x-kozou-embeds with a $ref target', () => {
    const schema = schemaOf([
      {
        name: 'books',
        description: 'Books.',
        columns: [col('id', 'uuid', { isPrimaryKey: true }), col('author_id', 'uuid')],
        primaryKey: ['id'],
        relations: [relation('author_id', 'authors')],
      },
      {
        name: 'authors',
        columns: [col('id', 'uuid', { isPrimaryKey: true }), col('display_name', 'text')],
        primaryKey: ['id'],
      },
    ]);
    const books = (buildOpenApiDocument(schema) as unknown as Doc).components.schemas[
      'public.books'
    ] as SchemaObj & { 'x-kozou-embeds'?: unknown[] };
    expect(books['x-kozou-embeds']).toEqual([
      {
        field: 'author_id',
        key: 'authors',
        target: '#/components/schemas/public.authors',
        cardinality: 'to-one',
      },
    ]);
  });

  it('lists reverse (to-many) relations as x-kozou-embeds', () => {
    const schema = schemaOf([
      { name: 'authors', columns: [col('id', 'uuid', { isPrimaryKey: true })], primaryKey: ['id'] },
      {
        name: 'books',
        columns: [col('id', 'uuid', { isPrimaryKey: true }), col('author_id', 'uuid')],
        primaryKey: ['id'],
        relations: [relation('author_id', 'authors')],
      },
    ]);
    const authors = (buildOpenApiDocument(schema) as unknown as Doc).components.schemas[
      'public.authors'
    ] as SchemaObj & { 'x-kozou-embeds'?: unknown[] };
    expect(authors['x-kozou-embeds']).toEqual([
      {
        field: 'author_id',
        key: 'books',
        target: '#/components/schemas/public.books',
        cardinality: 'to-many',
      },
    ]);
  });

  it('omits x-kozou-embeds when a resource has no exposed relation targets', () => {
    const vw = build().components.schemas['public.vw_active'] as SchemaObj & {
      'x-kozou-embeds'?: unknown;
    };
    expect(vw['x-kozou-embeds']).toBeUndefined();
  });
});
