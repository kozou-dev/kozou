import { describe, it, expect } from 'vitest';
import type { WidgetType } from '@kozou/core';
import { buildOpenApiDocument } from '../src/openapi.js';
import { schemaOf, col, relation } from './helpers.js';

type EmbedHint = { field: string; key: string; target: string; cardinality: string };
type SchemaObj = {
  type?: unknown;
  format?: string;
  enum?: unknown[];
  description?: string;
  required?: string[];
  minProperties?: number;
  properties?: Record<string, SchemaObj>;
  additionalProperties?: boolean;
  items?: SchemaObj;
  oneOf?: SchemaObj[];
  $ref?: string;
  'x-kozou-ai'?: string;
  'x-kozou-policy'?: string[];
  'x-kozou-widget'?: string;
  'x-kozou-embeds'?: EmbedHint[];
};

/** The `$ref` an operation's JSON request body points at, if any. */
function requestBodyRef(op: unknown): string | undefined {
  return (
    op as { requestBody?: { content?: Record<string, { schema?: { $ref?: string } }> } }
  ).requestBody?.content?.['application/json']?.schema?.$ref;
}

/** The schema of an operation's 200 `application/json` response. */
function okSchema(op: unknown): SchemaObj {
  return (
    op as { responses: Record<string, { content: Record<string, { schema: SchemaObj }> }> }
  ).responses['200'].content['application/json'].schema;
}
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
    // A view has no primary key, so it is not addressable by id: the document
    // must not advertise an item path the request handler would reject (400).
    expect(doc.paths['/vw_active/{id}']).toBeUndefined();
  });

  it('omits the item path for a primary-key-less table but keeps list + create', () => {
    const schema = schemaOf([
      {
        name: 'event_log',
        columns: [col('source', 'text'), col('payload', 'text')],
        primaryKey: [],
      },
    ]);
    const doc = buildOpenApiDocument(schema) as unknown as Doc;
    // Writable, so list + create stay available...
    expect(doc.paths['/event_log'].get).toBeDefined();
    expect(doc.paths['/event_log'].post).toBeDefined();
    // ...but there is no key to address a single row, so no item path is
    // advertised (get/patch/delete by id would 400 at runtime).
    expect(doc.paths['/event_log/{id}']).toBeUndefined();
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

  const paramNames = (op: unknown): string[] =>
    ((op as { parameters?: { name: string }[] }).parameters ?? []).map((p) => p.name);

  it('advertises the embed parameter only where the resource has embeddable relations', () => {
    const schema = schemaOf([
      {
        name: 'books',
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
    const doc = buildOpenApiDocument(schema) as unknown as Doc;
    // books has a forward (to-one) relation -> embed advertised on list + item.
    expect(paramNames(doc.paths['/books'].get)).toContain('embed');
    expect(paramNames(doc.paths['/books/{id}'].get)).toContain('embed');
    // authors is the reverse (to-many) target -> embed advertised there too.
    expect(paramNames(doc.paths['/authors'].get)).toContain('embed');
    expect(paramNames(doc.paths['/authors/{id}'].get)).toContain('embed');
  });

  it('omits the embed parameter where a resource has no embeddable relations', () => {
    const doc = build();
    // A view exposes no relations -> the embed parameter would only 400.
    expect(paramNames(doc.paths['/vw_active'].get)).not.toContain('embed');
    // A relation-less (but PK-backed) table likewise advertises no embed.
    expect(paramNames(doc.paths['/authors'].get)).not.toContain('embed');
    expect(paramNames(doc.paths['/authors/{id}'].get)).not.toContain('embed');
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

  // --- Request bodies (issue #83.1) --------------------------------------

  it('uses a create-input schema that only requires NOT NULL columns without a default', () => {
    const schema = schemaOf([
      {
        name: 'products',
        columns: [
          col('id', 'uuid', { isPrimaryKey: true, nullable: false, defaultExpr: 'gen_random_uuid()' }),
          col('name', 'text', { nullable: false }),
          col('status', 'text', { nullable: false, defaultExpr: "'draft'::text" }),
          col('note', 'textarea', { nullable: true }),
        ],
        primaryKey: ['id'],
      },
    ]);
    const doc = buildOpenApiDocument(schema) as unknown as Doc;

    // POST references a dedicated create-input schema, not the response row.
    expect(requestBodyRef(doc.paths['/products'].post)).toBe(
      '#/components/schemas/public.products.CreateInput',
    );
    const create = doc.components.schemas['public.products.CreateInput'];
    // Only the NOT NULL column with no default is required; id (default) and
    // status (default) and note (nullable) may be omitted -> empty body is valid.
    expect(create.required).toEqual(['name']);
    expect(create.additionalProperties).toBe(false);
    expect(Object.keys(create.properties ?? {})).toEqual(['id', 'name', 'status', 'note']);
  });

  it('uses a partial update-input schema with no required columns', () => {
    const schema = schemaOf([
      {
        name: 'products',
        columns: [
          col('id', 'uuid', { isPrimaryKey: true, nullable: false }),
          col('name', 'text', { nullable: false }),
        ],
        primaryKey: ['id'],
      },
    ]);
    const doc = buildOpenApiDocument(schema) as unknown as Doc;
    expect(requestBodyRef(doc.paths['/products/{id}'].patch)).toBe(
      '#/components/schemas/public.products.UpdateInput',
    );
    const update = doc.components.schemas['public.products.UpdateInput'];
    expect(update.required).toBeUndefined();
    // The runtime rejects an empty update (400 "No fields to update"), so the
    // schema requires at least one column.
    expect(update.minProperties).toBe(1);
    expect(update.additionalProperties).toBe(false);
    expect(Object.keys(update.properties ?? {})).toEqual(['id', 'name']);
  });

  it('emits a create-input but no update-input schema for a primary-key-less table', () => {
    const schema = schemaOf([
      { name: 'event_log', columns: [col('source', 'text'), col('payload', 'text')], primaryKey: [] },
    ]);
    const doc = buildOpenApiDocument(schema) as unknown as Doc;
    expect(doc.components.schemas['public.event_log.CreateInput']).toBeDefined();
    // No item path (no PK) -> no PATCH -> no update-input schema.
    expect(doc.components.schemas['public.event_log.UpdateInput']).toBeUndefined();
    expect(requestBodyRef(doc.paths['/event_log'].post)).toBe(
      '#/components/schemas/public.event_log.CreateInput',
    );
  });

  // --- Relation-select as=options (issue #83.2) --------------------------

  it('documents the as=options relation-select mode on a single-PK collection', () => {
    const schema = schemaOf([
      {
        name: 'products',
        columns: [col('id', 'uuid', { isPrimaryKey: true, nullable: false }), col('name', 'text')],
        primaryKey: ['id'],
      },
    ]);
    const doc = buildOpenApiDocument(schema) as unknown as Doc;
    expect(paramNames(doc.paths['/products'].get)).toEqual(
      expect.arrayContaining(['as', 'label', 'fields', 'q', 'limit']),
    );
    // The 200 offers both the list page and the { options } shape.
    const resp = okSchema(doc.paths['/products'].get);
    expect(resp.oneOf).toHaveLength(2);
    const optionsShape = (resp.oneOf ?? []).find((s) => s.properties?.options);
    expect(optionsShape?.properties?.options?.items?.required).toEqual(['id', 'label']);
  });

  it('omits as=options where there is no single-column primary key', () => {
    const schema = schemaOf(
      [
        {
          name: 'line_items',
          columns: [
            col('order_id', 'uuid', { isPrimaryKey: true, nullable: false }),
            col('sku', 'text', { isPrimaryKey: true, nullable: false }),
          ],
          primaryKey: ['order_id', 'sku'],
        },
        { name: 'event_log', columns: [col('payload', 'text')], primaryKey: [] },
      ],
      [{ name: 'vw_x', columns: [col('id', 'uuid')] }],
    );
    const doc = buildOpenApiDocument(schema) as unknown as Doc;
    for (const seg of ['/line_items', '/event_log', '/vw_x']) {
      expect(paramNames(doc.paths[seg].get)).not.toContain('as');
      expect(okSchema(doc.paths[seg].get).oneOf).toBeUndefined();
    }
  });

  it('merges (not duplicates) an options control into a colliding filter parameter', () => {
    const schema = schemaOf([
      {
        name: 'tags',
        columns: [col('id', 'uuid', { isPrimaryKey: true, nullable: false }), col('label', 'text')],
        primaryKey: ['id'],
      },
    ]);
    const doc = buildOpenApiDocument(schema) as unknown as Doc;
    const params =
      (doc.paths['/tags'].get as { parameters: { name: string; description: string }[] }).parameters;
    // Exactly one `label` parameter — emitting two would be invalid OpenAPI.
    const labelParams = params.filter((p) => p.name === 'label');
    expect(labelParams).toHaveLength(1);
    // ...and its description carries both the filter and the as=options meaning.
    expect(labelParams[0].description).toContain('Filter on `label`');
    expect(labelParams[0].description).toContain('as=options');
  });

  // --- Faithful embed hints (issue #83.3) --------------------------------

  it('drops reverse embeds when a child has multiple foreign keys to the parent', () => {
    // messages has two FKs to users (sender_id, recipient_id): the reverse
    // selector "messages" is ambiguous, so the runtime rejects it (400) and the
    // document must not advertise it on users.
    const schema = schemaOf([
      { name: 'users', columns: [col('id', 'uuid', { isPrimaryKey: true, nullable: false })], primaryKey: ['id'] },
      {
        name: 'messages',
        columns: [
          col('id', 'uuid', { isPrimaryKey: true, nullable: false }),
          col('sender_id', 'uuid'),
          col('recipient_id', 'uuid'),
        ],
        primaryKey: ['id'],
        relations: [relation('sender_id', 'users'), relation('recipient_id', 'users')],
      },
    ]);
    const doc = buildOpenApiDocument(schema) as unknown as Doc;
    const users = doc.components.schemas['public.users'];
    expect(users['x-kozou-embeds']).toBeUndefined();
    expect(paramNames(doc.paths['/users'].get)).not.toContain('embed');

    // messages keeps both forward relations (selectable by FK field) with
    // distinct, non-colliding keys.
    const keys = (doc.components.schemas['public.messages']['x-kozou-embeds'] ?? []).map((h) => h.key);
    expect(keys).toEqual(['users', 'recipient']);
  });

  it('derives an embed key that avoids colliding with a parent column', () => {
    const schema = schemaOf([
      {
        name: 'books',
        // a column literally named "authors" (the target table name) forces the
        // key to fall back to the stripped FK field.
        columns: [
          col('id', 'uuid', { isPrimaryKey: true, nullable: false }),
          col('author_id', 'uuid'),
          col('authors', 'number'),
        ],
        primaryKey: ['id'],
        relations: [relation('author_id', 'authors')],
      },
      { name: 'authors', columns: [col('id', 'uuid', { isPrimaryKey: true, nullable: false })], primaryKey: ['id'] },
    ]);
    const doc = buildOpenApiDocument(schema) as unknown as Doc;
    const hint = (doc.components.schemas['public.books']['x-kozou-embeds'] ?? [])[0];
    expect(hint).toEqual({
      field: 'author_id',
      key: 'author',
      target: '#/components/schemas/public.authors',
      cardinality: 'to-one',
    });
  });

  it('falls back to the raw child FK field for a reverse embed key (mirrors chooseKey)', () => {
    // The parent's columns shadow both the child table name and the stripped
    // FK, but the raw FK field lives on the child, so it is a usable key — the
    // runtime (chooseKey) would accept it, so the document must advertise it.
    const schema = schemaOf([
      {
        name: 'authors',
        columns: [
          col('id', 'uuid', { isPrimaryKey: true, nullable: false }),
          col('books', 'number'),
          col('author', 'text'),
        ],
        primaryKey: ['id'],
      },
      {
        name: 'books',
        columns: [col('id', 'uuid', { isPrimaryKey: true, nullable: false }), col('author_id', 'uuid')],
        primaryKey: ['id'],
        relations: [relation('author_id', 'authors')],
      },
    ]);
    const doc = buildOpenApiDocument(schema) as unknown as Doc;
    const hint = (doc.components.schemas['public.authors']['x-kozou-embeds'] ?? [])[0];
    expect(hint).toEqual({
      field: 'author_id',
      key: 'author_id',
      target: '#/components/schemas/public.books',
      cardinality: 'to-many',
    });
  });

  it('drops an embed whose every key candidate collides with a parent column', () => {
    const schema = schemaOf([
      {
        name: 'books',
        // both "authors" (target name) and "author" (stripped FK) are columns,
        // so no usable key exists -> the runtime would 400, so no hint/param.
        columns: [
          col('id', 'uuid', { isPrimaryKey: true, nullable: false }),
          col('author_id', 'uuid'),
          col('authors', 'number'),
          col('author', 'text'),
        ],
        primaryKey: ['id'],
        relations: [relation('author_id', 'authors')],
      },
      { name: 'authors', columns: [col('id', 'uuid', { isPrimaryKey: true, nullable: false })], primaryKey: ['id'] },
    ]);
    const doc = buildOpenApiDocument(schema) as unknown as Doc;
    expect(doc.components.schemas['public.books']['x-kozou-embeds']).toBeUndefined();
    expect(paramNames(doc.paths['/books'].get)).not.toContain('embed');
  });

  it('documents both forward and reverse selectors in the embed parameter', () => {
    const schema = schemaOf([
      { name: 'authors', columns: [col('id', 'uuid', { isPrimaryKey: true, nullable: false })], primaryKey: ['id'] },
      {
        name: 'books',
        columns: [col('id', 'uuid', { isPrimaryKey: true, nullable: false }), col('author_id', 'uuid')],
        primaryKey: ['id'],
        relations: [relation('author_id', 'authors')],
      },
    ]);
    const doc = buildOpenApiDocument(schema) as unknown as Doc;
    const embedDesc = (op: unknown): string =>
      (op as { parameters: { name: string; description: string }[] }).parameters.find(
        (p) => p.name === 'embed',
      )?.description ?? '';
    // authors is reverse-only (its only embeddable relation is the to-many
    // "books") -> the embed parameter must document the array + child-table
    // selector, not just forward objects.
    const authorsDesc = embedDesc(doc.paths['/authors'].get);
    expect(authorsDesc).toMatch(/to-many|array/);
    expect(authorsDesc).toMatch(/child table/);
    // and the forward (to-one nested object) case is still documented.
    expect(embedDesc(doc.paths['/books'].get)).toMatch(/to-one|nested object/);
  });
});
