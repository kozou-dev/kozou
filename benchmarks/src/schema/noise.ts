// Noise tables — the "haystack".
//
// Opaque, business-meaningless relations that pad the schema to a target
// scale. They carry NO business-trap semantics: comments (where present) are
// bland filler that never mentions revenue/soft-delete/status/etc., and they
// never touch the core tables, so no ground truth depends on them. Their only
// role is to make the schema large so that FINDING the relevant relations is
// the cost that separates selective navigation (Kozou) from broad describe/
// search (a generic MCP). Noise tables are left unseeded (empty rows); the
// agent cannot see row counts from the schema context, so emptiness does not
// betray them.

import { Mangler, REL_NS } from './mangle.js';
import type { ResolvedTable } from './domain.js';

const FILLER_COMMENTS = [
  'Reference data.',
  'Internal bookkeeping table.',
  'Legacy staging table.',
  'Lookup codes.',
  'Batch import scratch table.',
  undefined, // many legacy tables have no comment at all
  undefined,
];

const COL_TYPES = ['text', 'integer', 'numeric(12,2)', 'timestamptz', 'boolean', 'uuid'];

/** Deterministic small hash so per-table shape varies without randomness. */
function h(seed: string): number {
  let x = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    x ^= seed.charCodeAt(i);
    x = Math.imul(x, 16777619);
  }
  return x >>> 0;
}

/**
 * Build `count` noise tables. Each has an opaque name, an `id` PK, and a
 * deterministic handful of opaque columns; ~1/3 reference a PRIOR noise table
 * (never a core table) to give a realistic, self-contained join graph.
 */
export function buildNoiseTables(mangler: Mangler, count: number): ResolvedTable[] {
  const tables: ResolvedTable[] = [];
  const names: string[] = [];

  for (let i = 0; i < count; i += 1) {
    const key = `noise:${i}`;
    const name = mangler.name('table', REL_NS, key);
    const seed = h(`${name}#${i}`);
    const nCols = 3 + (seed % 4); // 3..6 columns beyond id

    const columns: ResolvedTable['columns'] = [
      { key: 'id', name: mangler.name('column', name, 'id'), type: 'uuid', notNull: true, default: 'gen_random_uuid()', pk: true, unique: false },
    ];
    for (let j = 0; j < nCols; j += 1) {
      const t = COL_TYPES[(seed >>> (j + 1)) % COL_TYPES.length];
      columns.push({
        key: `f${j}`,
        name: mangler.name('column', name, `f${j}`),
        type: t,
        notNull: false,
        pk: false,
        unique: false,
      });
    }

    const fks: ResolvedTable['fks'] = [];
    if (i > 0 && seed % 3 === 0) {
      const refIdx = seed % i;
      const refName = names[refIdx];
      const refTable = tables[refIdx];
      const fkColName = mangler.name('column', name, 'ref');
      columns.push({ key: 'ref', name: fkColName, type: 'uuid', notNull: false, pk: false, unique: false });
      fks.push({
        name: mangler.name('constraint', 'con', `${key}:ref`),
        column: fkColName,
        refTable: refName,
        refColumn: refTable.columns[0].name,
      });
    }

    const comment = FILLER_COMMENTS[seed % FILLER_COMMENTS.length];

    tables.push({ key, name, columns, fks, comment });
    names.push(name);
  }

  return tables;
}
