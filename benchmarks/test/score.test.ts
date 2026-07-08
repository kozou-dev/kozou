import { describe, expect, it } from 'vitest';

import { scoreRows } from '../src/score.js';
import type { Scoring } from '../src/types.js';

describe('scoreRows', () => {
  it('accepts a numeric match within tolerance (pg returns numerics as strings)', () => {
    const score = scoreRows({ kind: 'numeric', expected: 120 }, [['120.00']]);
    expect(score.correct).toBe(true);
    expect(score.errorRatio).toBe(1);
  });

  it('rejects a numeric miss and reports the severity ratio', () => {
    const score = scoreRows({ kind: 'numeric', expected: 120 }, [['575.00']]);
    expect(score.correct).toBe(false);
    expect(score.errorRatio).toBeCloseTo(575 / 120, 5);
  });

  it('rejects wrong shapes for numeric tasks', () => {
    expect(scoreRows({ kind: 'numeric', expected: 3 }, []).correct).toBe(false);
    expect(scoreRows({ kind: 'numeric', expected: 3 }, [['1'], ['2']]).correct).toBe(false);
    expect(scoreRows({ kind: 'numeric', expected: 3 }, [['a', 'b']]).correct).toBe(false);
  });

  it('rejects non-numeric values for numeric tasks', () => {
    expect(scoreRows({ kind: 'numeric', expected: 3 }, [['many']]).correct).toBe(false);
  });

  it('matches text answers case-insensitively including aliases', () => {
    const scoring: Scoring = {
      kind: 'text',
      expected: 'Carol Diaz',
      aliases: ['carol'],
    };
    expect(scoreRows(scoring, [['  CAROL DIAZ ']]).correct).toBe(true);
    expect(scoreRows(scoring, [['Carol']]).correct).toBe(true);
    expect(scoreRows(scoring, [['Bob Nguyen']]).correct).toBe(false);
  });

  it('matches string sets regardless of order and case', () => {
    const scoring: Scoring = {
      kind: 'string_set',
      expected: ['WID-001', 'GAD-001'],
    };
    expect(scoreRows(scoring, [['gad-001'], ['WID-001']]).correct).toBe(true);
    expect(scoreRows(scoring, [['WID-001']]).correct).toBe(false);
    expect(
      scoreRows(scoring, [['WID-001'], ['GAD-001'], ['GIZ-001']]).correct,
    ).toBe(false);
  });

  it('rejects join fan-out duplicates in string sets', () => {
    const scoring: Scoring = {
      kind: 'string_set',
      expected: ['WID-001', 'GAD-001'],
    };
    expect(
      scoreRows(scoring, [['WID-001'], ['GAD-001'], ['GAD-001']]).correct,
    ).toBe(false);
  });
});
