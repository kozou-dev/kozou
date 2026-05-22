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

describe('inferWidget (dev_spec §6.4)', () => {
  it('FK → relation-select (最優先)', () => {
    expect(
      inferWidget({
        column: col('artist_id', 'uuid'),
        isForeignKey: true,
        enumValues: ['a', 'b'],
        commentBody: '',
      }),
    ).toBe('relation-select');
  });

  it('enumValues あり → enum-select', () => {
    expect(
      inferWidget({
        column: col('status', 'text'),
        isForeignKey: false,
        enumValues: ['a', 'b'],
        commentBody: '',
      }),
    ).toBe('enum-select');
  });

  it('uuid → uuid', () => {
    expect(
      inferWidget({
        column: col('id', 'uuid'),
        isForeignKey: false,
        enumValues: null,
        commentBody: '',
      }),
    ).toBe('uuid');
  });

  it('bool → boolean', () => {
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
    'numeric udt %s → number',
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

  it('date → date', () => {
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
    'datetime udt %s → datetime',
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

  it.each(['json', 'jsonb'])('json udt %s → json', (udt) => {
    expect(
      inferWidget({
        column: col('metadata', udt),
        isForeignKey: false,
        enumValues: null,
        commentBody: '',
      }),
    ).toBe('json');
  });

  it('text + name に url → image-url', () => {
    expect(
      inferWidget({
        column: col('homepage_url', 'text'),
        isForeignKey: false,
        enumValues: null,
        commentBody: '',
      }),
    ).toBe('image-url');
  });

  it('text + name に image → image-url', () => {
    expect(
      inferWidget({
        column: col('image', 'text'),
        isForeignKey: false,
        enumValues: null,
        commentBody: '',
      }),
    ).toBe('image-url');
  });

  it('text + commentBody に markdown → textarea', () => {
    expect(
      inferWidget({
        column: col('bio', 'text'),
        isForeignKey: false,
        enumValues: null,
        commentBody: '作家の経歴 (markdown 可)',
      }),
    ).toBe('textarea');
  });

  it('text + commentBody に 本文 → textarea', () => {
    expect(
      inferWidget({
        column: col('description', 'text'),
        isForeignKey: false,
        enumValues: null,
        commentBody: '長い本文を保持',
      }),
    ).toBe('textarea');
  });

  it('その他 text → text', () => {
    expect(
      inferWidget({
        column: col('display_name', 'text'),
        isForeignKey: false,
        enumValues: null,
        commentBody: '表示名',
      }),
    ).toBe('text');
  });

  it('FK は enumValues より優先', () => {
    expect(
      inferWidget({
        column: col('artist_id', 'uuid'),
        isForeignKey: true,
        enumValues: ['a'],
        commentBody: '',
      }),
    ).toBe('relation-select');
  });

  it('enumValues は udt 推論より優先', () => {
    expect(
      inferWidget({
        column: col('status', 'text'),
        isForeignKey: false,
        enumValues: ['a', 'b'],
        commentBody: '',
      }),
    ).toBe('enum-select');
  });

  it('空配列 enumValues は無視', () => {
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
