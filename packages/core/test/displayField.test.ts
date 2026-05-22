import { describe, it, expect } from 'vitest';
import type { RawColumn } from '../src/index.js';
import { inferDisplayField } from '../src/displayField.js';

function col(name: string): RawColumn {
  return {
    name,
    dataType: 'text',
    udtName: 'text',
    nullable: true,
    defaultExpr: null,
    comment: null,
    position: 1,
  };
}

describe('inferDisplayField (Kozou v0.1 spec §6.5)', () => {
  it('name 列あり → name', () => {
    expect(
      inferDisplayField({ columns: [col('id'), col('name')], primaryKey: ['id'] }),
    ).toBe('name');
  });

  it('name なし + title あり → title', () => {
    expect(
      inferDisplayField({ columns: [col('id'), col('title')], primaryKey: ['id'] }),
    ).toBe('title');
  });

  it('name/title なし + label あり → label', () => {
    expect(
      inferDisplayField({ columns: [col('id'), col('label')], primaryKey: ['id'] }),
    ).toBe('label');
  });

  it('display_name → display_name', () => {
    expect(
      inferDisplayField({
        columns: [col('id'), col('display_name')],
        primaryKey: ['id'],
      }),
    ).toBe('display_name');
  });

  it('name_ja → name_ja', () => {
    expect(
      inferDisplayField({ columns: [col('id'), col('name_ja')], primaryKey: ['id'] }),
    ).toBe('name_ja');
  });

  it('name_en → name_en', () => {
    expect(
      inferDisplayField({ columns: [col('id'), col('name_en')], primaryKey: ['id'] }),
    ).toBe('name_en');
  });

  it('候補なし + 単一 PK → PK', () => {
    expect(
      inferDisplayField({
        columns: [col('id'), col('foo')],
        primaryKey: ['id'],
      }),
    ).toBe('id');
  });

  it('候補なし + 複合 PK → 先頭の PK', () => {
    expect(
      inferDisplayField({
        columns: [col('a'), col('b'), col('c')],
        primaryKey: ['a', 'b'],
      }),
    ).toBe('a');
  });

  it('候補なし + PK なし → null', () => {
    expect(
      inferDisplayField({ columns: [col('foo'), col('bar')], primaryKey: [] }),
    ).toBeNull();
  });

  it('priority: name が title より優先', () => {
    expect(
      inferDisplayField({
        columns: [col('id'), col('name'), col('title')],
        primaryKey: ['id'],
      }),
    ).toBe('name');
  });
});
