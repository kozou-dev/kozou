// Assemble the full synthetic schema at a given scale.
//
// The CORE domain is built first with a fixed seed, so its mangled names (and
// therefore every task's canonical_sql) are IDENTICAL at every scale — only
// the number of noise tables changes. This is what lets the same task set run
// unchanged at S/M/L and makes accuracy comparable across scales, with scale
// affecting only the navigation cost.

import { Mangler } from './mangle.js';
import { buildCoreDomain, type CoreDomain } from './domain.js';
import { buildNoiseTables } from './noise.js';
import { renderFixtureSql } from './render.js';

/** Pinned mangling seed. Changing it re-mangles every name (new fixture). */
export const SCHEMA_SEED = 'c10-v1';

/** Noise-table counts per scale. Core adds 4 tables + 2 views (6 relations),
 *  so total relations are ~16 (S), ~76 (M), ~201 (L) — matching the
 *  pre-registered scale bands S<=20 / M<=80 / L>=200. */
export const NOISE_COUNTS = { S: 10, M: 70, L: 195 } as const;
export type Scale = keyof typeof NOISE_COUNTS;
export const SCALES: readonly Scale[] = ['S', 'M', 'L'];

export interface GeneratedSchema {
  scale: Scale;
  seed: string;
  sql: string;
  /** semantic key -> mangled name (core only; noise is not in the legend). */
  legend: Record<string, string>;
  coreTableNames: string[];
  coreViewNames: string[];
  noiseTableCount: number;
  relationCount: number;
}

export function generateSchema(scale: Scale): GeneratedSchema {
  const mangler = new Mangler(SCHEMA_SEED);
  const core: CoreDomain = buildCoreDomain(mangler); // MUST be built before noise
  const noise = buildNoiseTables(mangler, NOISE_COUNTS[scale]);

  const sql = renderFixtureSql({
    tables: [...core.tables, ...noise],
    views: core.views,
    seedStatements: core.seedStatements,
  });

  return {
    scale,
    seed: SCHEMA_SEED,
    sql,
    legend: core.legend,
    coreTableNames: core.tables.map((t) => t.name),
    coreViewNames: core.views.map((v) => v.name),
    noiseTableCount: noise.length,
    relationCount: core.tables.length + core.views.length + noise.length,
  };
}
