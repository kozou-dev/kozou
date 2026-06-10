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

  it('accepts a value or null for a nullable column, but not undefined', () => {
    // The form always submits every field, defaulting an empty nullable
    // column to `null` (never `undefined`). Allowing `undefined` would
    // make superforms default the field to undefined, which crashes the
    // widget bindings (`$bindable('')`) with Svelte's
    // `props_invalid_value` on client-side navigation to /new and /edit.
    const schema = zodFromColumn(
      makeColumn({ widget: 'text', nullable: true }),
    );
    expect(schema.safeParse('hello').success).toBe(true);
    expect(schema.safeParse(null).success).toBe(true);
    expect(schema.safeParse(undefined).success).toBe(false);
  });

  it('accepts the empty-string sentinel for a column with a DEFAULT', () => {
    // A uuid PK with a gen_random_uuid() default is submitted empty by
    // the create form; the empty string must validate (the create route
    // then drops it so the DB default applies) instead of failing the
    // uuid check.
    const schema = zodFromColumn(
      makeColumn({ widget: 'uuid', nullable: false, defaultExpr: 'gen_random_uuid()' }),
    );
    expect(schema.safeParse('').success).toBe(true);
    expect(
      schema.safeParse('11111111-1111-1111-1111-111111111111').success,
    ).toBe(true);
    expect(schema.safeParse('not-a-uuid').success).toBe(false);
  });

  it('accepts the empty-string sentinel for a read-only column', () => {
    const schema = zodFromColumn(
      makeColumn({ widget: 'text', nullable: false, readonly: true }),
    );
    expect(schema.safeParse('').success).toBe(true);
    expect(schema.safeParse('value').success).toBe(true);
  });

  it('rejects the empty selection but accepts an id for a required relation-select', () => {
    // The multi-type union carries an explicit '' default so the superforms
    // adapter accepts it and form init resolves an absent field to '' (a bare
    // string|number union makes superValidate throw). A *submitted* empty
    // value, however, must fail: buildMutationPayload would turn it into null,
    // which a NOT NULL FK refuses at the database.
    const schema = zodFromColumn(
      makeColumn({ widget: 'relation-select', nullable: false }),
    );
    expect(schema.parse(undefined)).toBe(''); // form-init default
    expect(schema.safeParse('').success).toBe(false); // submitted empty rejected
    expect(
      schema.safeParse('11111111-1111-1111-1111-111111111111').success,
    ).toBe(true);
    expect(schema.safeParse(42).success).toBe(true);
    expect(schema.safeParse(null).success).toBe(false);
  });

  it('also accepts null for a nullable relation-select', () => {
    const schema = zodFromColumn(
      makeColumn({ widget: 'relation-select', nullable: true }),
    );
    expect(schema.safeParse('').success).toBe(true);
    expect(schema.safeParse('abc').success).toBe(true);
    expect(schema.safeParse(7).success).toBe(true);
    expect(schema.safeParse(null).success).toBe(true);
    expect(schema.parse(undefined)).toBe('');
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
