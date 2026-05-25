// Format a single cell value for the detail / list views.
// Picks the formatter from the column's WidgetType so booleans
// render as Yes/No, dates as YYYY-MM-DD, JSON as pretty-printed
// text, and unknown widgets fall back to String(value).

import type { WidgetType } from '@kozou/core';

export interface FormatCellInput {
  value: unknown;
  widget: WidgetType;
}

export function formatCellValue(input: FormatCellInput): string {
  const { value, widget } = input;
  if (value === null || value === undefined) return '';

  switch (widget) {
    case 'boolean':
      return value ? 'Yes' : 'No';
    case 'date':
      return formatDate(value);
    case 'datetime':
      return formatDateTime(value);
    case 'json':
      if (typeof value === 'object') {
        try {
          return JSON.stringify(value, null, 2);
        } catch {
          return String(value);
        }
      }
      return String(value);
    default:
      if (typeof value === 'object') {
        try {
          return JSON.stringify(value);
        } catch {
          return String(value);
        }
      }
      return String(value);
  }
}

function formatDate(value: unknown): string {
  const d = new Date(value as string | number | Date);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toISOString().slice(0, 10);
}

function formatDateTime(value: unknown): string {
  const d = new Date(value as string | number | Date);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toISOString().replace('T', ' ').slice(0, 19);
}
