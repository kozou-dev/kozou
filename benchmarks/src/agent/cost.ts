// Token-cost derivation from raw per-turn usage.
//
// Two pinned headline figures (see README / pre-registration):
//   - uncached: input + cache_creation + cache_read summed over turns. This is
//     the token count you would pay WITHOUT caching (the full context re-sent
//     each turn) — the intrinsic context-volume diagnostic.
//   - billed:   input*1 + cache_creation*1.25 + cache_read*0.1 summed over
//     turns — the real cost WITH prompt caching, using the pinned price
//     weights. This is the headline cost metric.

import type { TurnUsage } from './loop.js';

/** Pinned billed-cost weights (Anthropic prompt-cache pricing multipliers). */
export const CACHE_WRITE_WEIGHT = 1.25;
export const CACHE_READ_WEIGHT = 0.1;

export interface DerivedCost {
  /** Intrinsic context volume (caching-off equivalent input tokens). */
  uncachedInput: number;
  /** Billed input-token equivalent (caching-on, pinned weights). */
  billedInput: number;
  outputTokens: number;
}

export function deriveCost(usage: TurnUsage[]): DerivedCost {
  let uncached = 0;
  let billed = 0;
  let output = 0;
  for (const t of usage) {
    uncached += t.input + t.cacheCreation + t.cacheRead;
    billed += t.input + t.cacheCreation * CACHE_WRITE_WEIGHT + t.cacheRead * CACHE_READ_WEIGHT;
    output += t.output;
  }
  return { uncachedInput: uncached, billedInput: billed, outputTokens: output };
}
