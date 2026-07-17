// Task-level statistical analysis (pre-registered).
//
// Analysis unit is the TASK (runs estimate within-task variance only), so all
// inference uses a CLUSTER BOOTSTRAP over the task set. This avoids the prior
// benchmark's error of treating runs as independent samples.
//
// Co-primary endpoints (see the pre-registration):
//   P1  accuracy C-B at L (two-sided; superiority if the CI lower bound clears
//       the +10pt floor; F1-critical inferiority if C is significantly worse).
//   P2  cost slope (B's cost grows >= 2x C's from S to L) AND accuracy
//       non-inferiority at L (C >= B - 7pt).
// Family-wise error across the two co-primaries is controlled Bonferroni-style
// by using 97.5% CIs for the co-primary decisions (passing Bonferroni implies
// passing Holm, which is at least as powerful). Descriptive stats use 95%.
//
// Reproduction (a separate step) requires the SAME decision to hold in two
// independent batches; see `combineReproduction`.

import type { ArmId } from '../types.js';
import type { Scale } from '../schema/generate.js';

export interface CellRecord {
  taskId: string;
  scale: Scale;
  arm: ArmId;
  run: number;
  correct: boolean;
  billedInput: number;
  uncachedInput: number;
  capHit: boolean;
}

export interface PreRegParams {
  /** P1 accuracy superiority floor (fraction, e.g. 0.10). */
  accuracyFloor: number;
  /** Non-inferiority margin delta (fraction, e.g. 0.07). */
  niMargin: number;
  /** P2 cost-growth ratio floor (B growth / C growth, e.g. 2). */
  slopeRatioFloor: number;
  bootstrapIters: number;
  seed: number;
}

export const DEFAULT_PARAMS: PreRegParams = {
  accuracyFloor: 0.1,
  niMargin: 0.07,
  slopeRatioFloor: 2,
  bootstrapIters: 5000,
  seed: 0xc10,
};

// --- seeded RNG (mulberry32) so bootstrap CIs are reproducible ---------------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function quantile(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) return NaN;
  const idx = (sortedAsc.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
}

export interface CI {
  point: number;
  lo: number;
  hi: number;
  level: number;
}

// --- per-(arm,scale,task) aggregation ----------------------------------------
interface CellAgg {
  accuracy: number; // over all runs
  meanBilled: number; // over non-cap runs (NaN if all cap-hit)
  meanUncached: number;
  capHitRate: number;
  n: number;
}

function key(arm: ArmId, scale: Scale, taskId: string): string {
  return `${arm}|${scale}|${taskId}`;
}

function aggregate(records: CellRecord[]): {
  cells: Map<string, CellAgg>;
  tasksByScale: Map<Scale, string[]>;
} {
  const groups = new Map<string, CellRecord[]>();
  for (const r of records) {
    const k = key(r.arm, r.scale, r.taskId);
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(r);
  }
  const cells = new Map<string, CellAgg>();
  const tasksByScale = new Map<Scale, Set<string>>();
  for (const [k, rs] of groups) {
    const scale = rs[0].scale;
    (tasksByScale.get(scale) ?? tasksByScale.set(scale, new Set()).get(scale)!).add(rs[0].taskId);
    const nonCap = rs.filter((r) => !r.capHit);
    const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
    cells.set(k, {
      accuracy: mean(rs.map((r) => (r.correct ? 1 : 0))),
      meanBilled: mean(nonCap.map((r) => r.billedInput)),
      meanUncached: mean(nonCap.map((r) => r.uncachedInput)),
      capHitRate: mean(rs.map((r) => (r.capHit ? 1 : 0))),
      n: rs.length,
    });
  }
  const out = new Map<Scale, string[]>();
  for (const [s, set] of tasksByScale) out.set(s, [...set].sort());
  return { cells, tasksByScale: out };
}

// --- bootstrap over tasks ----------------------------------------------------
function bootstrap(
  tasks: string[],
  statistic: (sampledTasks: string[]) => number,
  iters: number,
  seed: number,
  level: number,
): CI {
  const rng = mulberry32(seed);
  const point = statistic(tasks);
  const dist: number[] = [];
  for (let i = 0; i < iters; i += 1) {
    const sample: string[] = [];
    for (let j = 0; j < tasks.length; j += 1) sample.push(tasks[Math.floor(rng() * tasks.length)]);
    const s = statistic(sample);
    if (Number.isFinite(s)) dist.push(s);
  }
  dist.sort((a, b) => a - b);
  const alpha = (1 - level) / 2;
  return { point, lo: quantile(dist, alpha), hi: quantile(dist, 1 - alpha), level };
}

export interface BatchReport {
  params: PreRegParams;
  armAccuracy: Record<string, Record<string, number>>; // arm -> scale -> accuracy
  armBilled: Record<string, Record<string, number>>; // arm -> scale -> mean billed (non-cap)
  capHitRate: Record<string, Record<string, number>>;
  accuracyDelta: Record<string, CI>; // scale -> C-B accuracy CI (95%)
  accuracyDeltaCoprimaryL: CI; // C-B accuracy at L (97.5%)
  slopeRatioBoverC: CI; // B billed-growth / C billed-growth (97.5%)
  decision: {
    p1Superiority: boolean; // S/M or L accuracy superiority beyond floor
    p1SuperiorityAtSorM: boolean; // S1 requires S or M
    negativeReplicate: boolean; // C significantly worse (F1 direction)
    nonInferiorityAtL: boolean;
    p2Slope: boolean;
    scenario: 'S1' | 'S2' | 'S3' | 'F1';
  };
}

function armScaleMeanAccuracy(
  cells: Map<string, CellAgg>,
  arm: ArmId,
  scale: Scale,
  tasks: string[],
): number {
  const vals = tasks.map((t) => cells.get(key(arm, scale, t))?.accuracy).filter((v): v is number => v !== undefined && Number.isFinite(v));
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : NaN;
}

function armScaleMeanBilled(
  cells: Map<string, CellAgg>,
  arm: ArmId,
  scale: Scale,
  tasks: string[],
): number {
  const vals = tasks.map((t) => cells.get(key(arm, scale, t))?.meanBilled).filter((v): v is number => v !== undefined && Number.isFinite(v));
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : NaN;
}

export function analyzeBatch(records: CellRecord[], params: PreRegParams = DEFAULT_PARAMS): BatchReport {
  const { cells, tasksByScale } = aggregate(records);
  const scales = [...tasksByScale.keys()];
  const arms: ArmId[] = ['A', 'B', 'C'];

  const armAccuracy: Record<string, Record<string, number>> = {};
  const armBilled: Record<string, Record<string, number>> = {};
  const capHitRate: Record<string, Record<string, number>> = {};
  for (const arm of arms) {
    armAccuracy[arm] = {};
    armBilled[arm] = {};
    capHitRate[arm] = {};
    for (const scale of scales) {
      const tasks = tasksByScale.get(scale) ?? [];
      armAccuracy[arm][scale] = armScaleMeanAccuracy(cells, arm, scale, tasks);
      armBilled[arm][scale] = armScaleMeanBilled(cells, arm, scale, tasks);
      const chr = tasks.map((t) => cells.get(key(arm, scale, t))?.capHitRate).filter((v): v is number => v !== undefined && Number.isFinite(v));
      capHitRate[arm][scale] = chr.length ? chr.reduce((a, b) => a + b, 0) / chr.length : NaN;
    }
  }

  // Accuracy C-B per scale (paired by task).
  const accuracyDelta: Record<string, CI> = {};
  const deltaStat = (scale: Scale) => (sample: string[]): number => {
    let sum = 0;
    let n = 0;
    for (const t of sample) {
      const c = cells.get(key('C', scale, t))?.accuracy;
      const b = cells.get(key('B', scale, t))?.accuracy;
      if (c !== undefined && b !== undefined && Number.isFinite(c) && Number.isFinite(b)) {
        sum += c - b;
        n += 1;
      }
    }
    return n ? sum / n : NaN;
  };
  for (const scale of scales) {
    accuracyDelta[scale] = bootstrap(tasksByScale.get(scale) ?? [], deltaStat(scale), params.bootstrapIters, params.seed, 0.95);
  }

  const hasL = scales.includes('L');
  const accuracyDeltaCoprimaryL = hasL
    ? bootstrap(tasksByScale.get('L') ?? [], deltaStat('L'), params.bootstrapIters, params.seed + 1, 0.975)
    : { point: NaN, lo: NaN, hi: NaN, level: 0.975 };

  // Cost slope: (B billed growth S->L) / (C billed growth S->L).
  const slopeStat = (sample: string[]): number => {
    const meanOver = (arm: ArmId, scale: Scale): number => {
      const vals = sample.map((t) => cells.get(key(arm, scale, t))?.meanBilled).filter((v): v is number => v !== undefined && Number.isFinite(v));
      return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : NaN;
    };
    const bGrow = meanOver('B', 'L') / meanOver('B', 'S');
    const cGrow = meanOver('C', 'L') / meanOver('C', 'S');
    return cGrow === 0 ? NaN : bGrow / cGrow;
  };
  const slopeRatioBoverC = hasL && scales.includes('S')
    ? bootstrap(tasksByScale.get('L') ?? [], slopeStat, params.bootstrapIters, params.seed + 2, 0.975)
    : { point: NaN, lo: NaN, hi: NaN, level: 0.975 };

  // Decisions.
  const supBeyondFloor = (ci: CI): boolean => Number.isFinite(ci.lo) && ci.lo > params.accuracyFloor;
  const p1SuperiorityAtSorM = ['S', 'M'].some((s) => scales.includes(s as Scale) && supBeyondFloor(accuracyDelta[s]));
  const p1SuperiorityAtL = supBeyondFloor(accuracyDeltaCoprimaryL);
  const p1Superiority = p1SuperiorityAtSorM || p1SuperiorityAtL;
  const negativeReplicate = Number.isFinite(accuracyDeltaCoprimaryL.hi) && accuracyDeltaCoprimaryL.hi < 0;
  const nonInferiorityAtL = Number.isFinite(accuracyDeltaCoprimaryL.lo) && accuracyDeltaCoprimaryL.lo > -params.niMargin;
  const p2Slope = Number.isFinite(slopeRatioBoverC.lo) && slopeRatioBoverC.lo > params.slopeRatioFloor;

  let scenario: 'S1' | 'S2' | 'S3' | 'F1';
  if (negativeReplicate) scenario = 'F1';
  else if (p1SuperiorityAtSorM) scenario = 'S1';
  else if ((p2Slope && nonInferiorityAtL) || (p1SuperiorityAtL && nonInferiorityAtL)) scenario = 'S2';
  else scenario = 'S3';

  return {
    params,
    armAccuracy,
    armBilled,
    capHitRate,
    accuracyDelta,
    accuracyDeltaCoprimaryL,
    slopeRatioBoverC,
    decision: { p1Superiority, p1SuperiorityAtSorM, negativeReplicate, nonInferiorityAtL, p2Slope, scenario },
  };
}

/** Reproduction: the pre-registered decision must hold in BOTH batches. */
export function combineReproduction(b1: BatchReport, b2: BatchReport): {
  reproduced: boolean;
  scenario: BatchReport['decision']['scenario'] | 'not-reproduced';
} {
  const same = b1.decision.scenario === b2.decision.scenario;
  return {
    reproduced: same,
    scenario: same ? b1.decision.scenario : 'not-reproduced',
  };
}
