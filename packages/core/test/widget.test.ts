import { describe, it, expect } from 'vitest';
import type { RawColumn } from '../src/index.js';
import { inferWidget } from '../src/widget.js';

function col(name: string, udtName: string, dataType = udtName): RawColumn {
  return {
    name,
    dataType,
    udtName,
    nullable: true,
    defaultExpr: null,
    comment: null,
    position: 1,
  };
}

describe('inferWidget (Kozou v0.1 spec §6.4)', () => {
  it('FK -> relation-select (highest priority)', () => {
    expect(
      inferWidget({
        column: col('author_id', 'uuid'),
        isForeignKey: true,
        enumValues: ['a', 'b'],
        commentBody: '',
      }),
    ).toBe('relation-select');
  });

  it('enumValues present -> enum-select', () => {
    expect(
      inferWidget({
        column: col('status', 'text'),
        isForeignKey: false,
        enumValues: ['a', 'b'],
        commentBody: '',
      }),
    ).toBe('enum-select');
  });

  it('uuid -> uuid', () => {
    expect(
      inferWidget({
        column: col('id', 'uuid'),
        isForeignKey: false,
        enumValues: null,
        commentBody: '',
      }),
    ).toBe('uuid');
  });

  it('bool -> boolean', () => {
    expect(
      inferWidget({
        column: col('is_active', 'bool'),
        isForeignKey: false,
        enumValues: null,
        commentBody: '',
      }),
    ).toBe('boolean');
  });

  it.each(['int2', 'int4', 'int8', 'numeric', 'float4', 'float8'])(
    'numeric udt %s -> number',
    (udt) => {
      expect(
        inferWidget({
          column: col('amount', udt),
          isForeignKey: false,
          enumValues: null,
          commentBody: '',
        }),
      ).toBe('number');
    },
  );

  it('date -> date', () => {
    expect(
      inferWidget({
        column: col('released_at', 'date'),
        isForeignKey: false,
        enumValues: null,
        commentBody: '',
      }),
    ).toBe('date');
  });

  it.each(['timestamp', 'timestamptz', 'time', 'timetz'])(
    'datetime udt %s -> datetime',
    (udt) => {
      expect(
        inferWidget({
          column: col('created_at', udt),
          isForeignKey: false,
          enumValues: null,
          commentBody: '',
        }),
      ).toBe('datetime');
    },
  );

  it.each(['json', 'jsonb'])('json udt %s -> json', (udt) => {
    expect(
      inferWidget({
        column: col('metadata', udt),
        isForeignKey: false,
        enumValues: null,
        commentBody: '',
      }),
    ).toBe('json');
  });

  it('text + name contains url -> image-url', () => {
    expect(
      inferWidget({
        column: col('homepage_url', 'text'),
        isForeignKey: false,
        enumValues: null,
        commentBody: '',
      }),
    ).toBe('image-url');
  });

  it('text + name contains image -> image-url', () => {
    expect(
      inferWidget({
        column: col('image', 'text'),
        isForeignKey: false,
        enumValues: null,
        commentBody: '',
      }),
    ).toBe('image-url');
  });

  it('text + commentBody mentions markdown -> textarea', () => {
    expect(
      inferWidget({
        column: col('bio', 'text'),
        isForeignKey: false,
        enumValues: null,
        commentBody: 'author bio (markdown allowed)',
      }),
    ).toBe('textarea');
  });

  it('text + commentBody mentions "body" -> textarea', () => {
    expect(
      inferWidget({
        column: col('description', 'text'),
        isForeignKey: false,
        enumValues: null,
        commentBody: 'stores the body text of an article',
      }),
    ).toBe('textarea');
  });

  it('plain text column -> text', () => {
    expect(
      inferWidget({
        column: col('display_name', 'text'),
        isForeignKey: false,
        enumValues: null,
        commentBody: 'display name',
      }),
    ).toBe('text');
  });

  it('FK beats enumValues', () => {
    expect(
      inferWidget({
        column: col('author_id', 'uuid'),
        isForeignKey: true,
        enumValues: ['a'],
        commentBody: '',
      }),
    ).toBe('relation-select');
  });

  it('enumValues beats udt inference', () => {
    expect(
      inferWidget({
        column: col('status', 'text'),
        isForeignKey: false,
        enumValues: ['a', 'b'],
        commentBody: '',
      }),
    ).toBe('enum-select');
  });

  it('empty enumValues is ignored', () => {
    expect(
      inferWidget({
        column: col('display_name', 'text'),
        isForeignKey: false,
        enumValues: [],
        commentBody: '',
      }),
    ).toBe('text');
  });
});
