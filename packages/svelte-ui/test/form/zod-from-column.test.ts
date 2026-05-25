import { describe, expect, it } from 'vitest';

import type { ColumnContext, WidgetType } from '@kozou/core';

import { zodFromColumn } from '../../src/lib/form/zod-from-column.js';

function makeColumn(overrides: Partial<ColumnContext>): ColumnContext {
  return {
    name: 'col',
    dataType: 'text',
    nullable: false,
    defaultExpr: null,
    isPrimaryKey: false,
    isForeignKey: false,
    label: 'Col',
    description: null,
    aiDescription: null,
    widget: 'text' as WidgetType,
    enumValues: null,
    readonly: false,
    ...overrides,
  };
}

describe('zodFromColumn', () => {
  it('returns a non-empty zod string schema for a NOT NULL text column', () => {
    const schema = zodFromColumn(
      makeColumn({ widget: 'text', nullable: false }),
    );
    expect(schema.safeParse('hello').success).toBe(true);
    expect(schema.safeParse(undefined).success).toBe(false);
  });

  it('coerces number widget values from strings', () => {
    const schema = zodFromColumn(
      makeColumn({ widget: 'number', dataType: 'integer', nullable: false }),
    );
    const parsed = schema.safeParse('42');
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toBe(42);
    }
  });

  it('uses z.enum for an enum-select column with enumValues populated', () => {
    const schema = zodFromColumn(
      makeColumn({
        widget: 'enum-select',
        nullable: false,
        enumValues: ['draft', 'published'],
      }),
    );
    expect(schema.safeParse('draft').success).toBe(true);
    expect(schema.safeParse('archived').success).toBe(false);
  });

  it('validates RFC 4122 UUIDs for a uuid widget', () => {
    const schema = zodFromColumn(makeColumn({ widget: 'uuid', nullable: false }));
    expect(
      schema.safeParse('11111111-1111-1111-1111-111111111111').success,
    ).toBe(true);
    expect(schema.safeParse('not-a-uuid').success).toBe(false);
  });

  it('wraps the inner schema in nullable + optional when the column is nullable', () => {
    const schema = zodFromColumn(
      makeColumn({ widget: 'text', nullable: true }),
    );
    expect(schema.safeParse('hello').success).toBe(true);
    expect(schema.safeParse(null).success).toBe(true);
    expect(schema.safeParse(undefined).success).toBe(true);
  });

  it('coerces boolean widget values from string inputs (form submissions)', () => {
    const schema = zodFromColumn(
      makeColumn({ widget: 'boolean', dataType: 'boolean', nullable: false }),
    );
    const parsed = schema.safeParse('true');
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toBe(true);
    }
  });
});
