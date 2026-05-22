import type { RawColumn } from './types/raw.js';

const CANDIDATES = ['name', 'title', 'label', 'display_name', 'name_ja', 'name_en'];

export type InferDisplayFieldInput = {
  columns: RawColumn[];
  primaryKey: string[];
};

export function inferDisplayField(input: InferDisplayFieldInput): string | null {
  const columnNames = new Set(input.columns.map((c) => c.name));
  for (const candidate of CANDIDATES) {
    if (columnNames.has(candidate)) return candidate;
  }
  return input.primaryKey[0] ?? null;
}
