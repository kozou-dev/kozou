import { describe, expect, it } from 'vitest';

import { formatCellValue } from '../../src/detail/format-cell.js';

describe('formatCellValue', () => {
  it('renders boolean widget values as Yes / No', () => {
    expect(formatCellValue({ value: true, widget: 'boolean' })).toBe('Yes');
    expect(formatCellValue({ value: false, widget: 'boolean' })).toBe('No');
  });

  it('renders date / datetime widget values as ISO-8601 substrings', () => {
    const iso = '2026-05-25T14:30:00.000Z';
    expect(formatCellValue({ value: iso, widget: 'date' })).toBe('2026-05-25');
    expect(formatCellValue({ value: iso, widget: 'datetime' })).toBe(
      '2026-05-25 14:30:00',
    );
  });

  it('pretty-prints object values for the json widget', () => {
    const result = formatCellValue({
      value: { kind: 'login', actor: 'sys' },
      widget: 'json',
    });
    expect(result).toBe('{\n  "kind": "login",\n  "actor": "sys"\n}');
  });

  it('returns an empty string for null and undefined regardless of widget', () => {
    expect(formatCellValue({ value: null, widget: 'text' })).toBe('');
    expect(formatCellValue({ value: undefined, widget: 'number' })).toBe('');
    expect(formatCellValue({ value: null, widget: 'json' })).toBe('');
  });

  it('falls back to String(value) for unknown widget shapes / values', () => {
    expect(formatCellValue({ value: 42, widget: 'number' })).toBe('42');
    expect(formatCellValue({ value: 'plain', widget: 'text' })).toBe('plain');
    expect(
      formatCellValue({ value: 'not-a-date', widget: 'date' }),
    ).toBe('not-a-date');
  });
});
