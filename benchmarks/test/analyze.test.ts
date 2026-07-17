// Statistical analysis on synthetic records: each scenario is engineered so
// the pre-registered decision is unambiguous.

import { describe, expect, it } from 'vitest';

import { analyzeBatch, combineReproduction, DEFAULT_PARAMS, type CellRecord } from '../src/stats/analyze.js';
import type { Scale } from '../src/schema/generate.js';
import type { ArmId } from '../src/types.js';

const SCALES: Scale[] = ['S', 'M', 'L'];
const NTASKS = 12;
const RUNS = 10;

interface CellCfg {
  correctProb: (arm: ArmId, scale: Scale) => number;
  billed: (arm: ArmId, scale: Scale) => number;
}

function make(cfg: CellCfg): CellRecord[] {
  const recs: CellRecord[] = [];
  for (const scale of SCALES) {
    for (let i = 0; i < NTASKS; i += 1) {
      const taskId = `t${i}`;
      for (const arm of ['A', 'B', 'C'] as ArmId[]) {
        const p = cfg.correctProb(arm, scale);
        for (let run = 0; run < RUNS; run += 1) {
          // Deterministic "probability": first round(p*RUNS) runs are correct.
          const correct = run < Math.round(p * RUNS);
          recs.push({
            taskId, scale, arm, run,
            correct,
            billedInput: cfg.billed(arm, scale),
            uncachedInput: cfg.billed(arm, scale),
            capHit: false,
          });
        }
      }
    }
  }
  return recs;
}

const flatCost = () => 1000;

describe('analyzeBatch scenarios', () => {
  it('S1: C beats B on accuracy at S/M (beyond the floor)', () => {
    const recs = make({
      correctProb: (arm) => (arm === 'C' ? 1 : arm === 'B' ? 0.3 : 0.1),
      billed: flatCost,
    });
    const r = analyzeBatch(recs);
    expect(r.decision.scenario).toBe('S1');
    expect(r.decision.p1SuperiorityAtSorM).toBe(true);
  });

  it('S2: accuracy equal, but B cost grows >=2x C from S to L', () => {
    const recs = make({
      correctProb: () => 1, // all arms equal accuracy
      billed: (arm, scale) => {
        if (arm === 'C') return 1000; // flat across scale
        if (arm === 'B') return scale === 'S' ? 1000 : scale === 'M' ? 3000 : 5000; // grows 5x
        return 1000;
      },
    });
    const r = analyzeBatch(recs);
    expect(r.decision.nonInferiorityAtL).toBe(true);
    expect(r.decision.p2Slope).toBe(true);
    expect(r.decision.scenario).toBe('S2');
  });

  it('S3: everything equal, no cost slope', () => {
    const recs = make({ correctProb: () => 0.9, billed: flatCost });
    const r = analyzeBatch(recs);
    expect(r.decision.scenario).toBe('S3');
  });

  it('F1: C significantly worse than B at L', () => {
    const recs = make({
      correctProb: (arm) => (arm === 'C' ? 0 : 1),
      billed: flatCost,
    });
    const r = analyzeBatch(recs);
    expect(r.decision.negativeReplicate).toBe(true);
    expect(r.decision.scenario).toBe('F1');
  });

  it('frozen rule: a SUB-delta deficit is NOT F1 (needs point <= -delta, not just significant negative)', () => {
    // C=0.45, B=0.50 -> delta -0.05, inside the 7pt margin. The old code
    // (hi<0) would have branded this moat-F1; the frozen rule must not.
    const recs: CellRecord[] = [];
    const RUNS20 = 20;
    for (const scale of SCALES) {
      for (let i = 0; i < NTASKS; i += 1) {
        for (const arm of ['A', 'B', 'C'] as ArmId[]) {
          const correctN = arm === 'C' ? 9 : 10; // C 9/20=0.45, B/A 10/20=0.50
          for (let run = 0; run < RUNS20; run += 1) {
            recs.push({ taskId: `t${i}`, scale, arm, run, correct: run < correctN, billedInput: 1000, uncachedInput: 1000, capHit: false });
          }
        }
      }
    }
    const r = analyzeBatch(recs);
    expect(r.accuracyDeltaCoprimaryL.point).toBeCloseTo(-0.05, 3);
    expect(r.decision.negativeReplicate).toBe(false);
    expect(r.decision.scenario).not.toBe('F1');
  });

  it('reports per-arm accuracy and cap-hit rate', () => {
    const recs = make({ correctProb: (arm) => (arm === 'C' ? 1 : 0.5), billed: flatCost });
    const r = analyzeBatch(recs);
    expect(r.armAccuracy.C.S).toBeCloseTo(1, 6);
    expect(r.capHitRate.C.S).toBe(0);
  });
});

describe('combineReproduction', () => {
  it('reproduced only when both batches agree', () => {
    const s2 = analyzeBatch(make({
      correctProb: () => 1,
      billed: (arm, scale) => (arm === 'B' ? (scale === 'S' ? 1000 : 5000) : 1000),
    }), DEFAULT_PARAMS);
    const s3 = analyzeBatch(make({ correctProb: () => 0.9, billed: flatCost }));
    expect(combineReproduction(s2, s2).reproduced).toBe(true);
    expect(combineReproduction(s2, s2).scenario).toBe('S2');
    expect(combineReproduction(s2, s3).reproduced).toBe(false);
  });
});
