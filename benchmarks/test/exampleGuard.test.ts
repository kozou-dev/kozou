// C-2 example-readback guard: no comment reproduces a task's canonical_sql.

import { describe, expect, it } from 'vitest';

import { generateSchema, SCALES } from '../src/schema/generate.js';
import { loadTasks } from '../src/tasks.js';
import { checkExampleGuard, jaccard } from '../src/gates/exampleGuard.js';

const tasks = loadTasks();
const canonicalSqls = tasks.map((t) => t.canonical_sql);

describe('trigram jaccard', () => {
  it('is 1 for identical text and low for unrelated', () => {
    expect(jaccard('select foo from bar', 'select foo from bar')).toBeCloseTo(1, 6);
    expect(jaccard('select foo from bar', 'the quick brown fox')).toBeLessThan(0.2);
  });
});

describe('example guard', () => {
  it.each(SCALES)('no comment fragment reproduces any canonical_sql (scale %s)', (scale) => {
    const { sql } = generateSchema(scale);
    const result = checkExampleGuard(sql, canonicalSqls, 0.5);
    expect(result.ok, JSON.stringify(result.violations, null, 2)).toBe(true);
    // Comfortable margin below the threshold.
    expect(result.maxSimilarity).toBeLessThan(0.5);
  });

  it('would flag a comment that embeds a canonical_sql', () => {
    const evil = `COMMENT ON TABLE x IS '@example: ${canonicalSqls[0]}';`;
    const result = checkExampleGuard(evil, canonicalSqls, 0.5);
    expect(result.ok).toBe(false);
  });
});
