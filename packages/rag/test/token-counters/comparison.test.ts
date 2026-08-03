/**
 * Token Counter Comparison Tests
 *
 * Compare accuracy and performance of different token counters.
 */

import { describe, expect, it } from 'vitest';

import { ApproximateTokenCounter } from '../../src/token-counters/approximate-token-counter.js';
import { FastTokenCounter } from '../../src/token-counters/fast-token-counter.js';

/**
 * Best of N after a warm-up pass.
 *
 * A single cold call measures JIT compilation, not the counter: whichever counter
 * runs first pays that cost, and on a loaded CI runner it dominates the real
 * difference outright (an observed run had the length-division counter "slower"
 * than full BPE tokenization). Warming up and taking the MINIMUM measures
 * steady-state throughput, which is the claim being made.
 */
function bestOf(count: () => void, runs = 5): number {
  count(); // warm-up: JIT compile, populate any lazy tables
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < runs; i += 1) {
    const start = performance.now();
    count();
    best = Math.min(best, performance.now() - start);
  }
  return best;
}

describe('Token Counter Comparison', () => {
  const fast = new FastTokenCounter();
  const approximate = new ApproximateTokenCounter();

  // Known accurate token counts from GPT tokenizer
  const testCases = [
    { text: 'Hello world', knownTokens: 2 },
    { text: 'The quick brown fox', knownTokens: 4 },
    { text: 'Artificial intelligence', knownTokens: 3 },
    { text: 'TypeScript is a typed superset of JavaScript', knownTokens: 9 },
  ];

  it('should show ApproximateTokenCounter is more accurate than FastTokenCounter', () => {
    let fastErrorSum = 0;
    let approximateErrorSum = 0;

    for (const { text, knownTokens } of testCases) {
      const fastCount = fast.count(text);
      const approximateCount = approximate.count(text);

      const fastError = Math.abs(fastCount - knownTokens) / knownTokens;
      const approximateError = Math.abs(approximateCount - knownTokens) / knownTokens;

      fastErrorSum += fastError;
      approximateErrorSum += approximateError;
    }

    const fastAvgError = fastErrorSum / testCases.length;
    const approximateAvgError = approximateErrorSum / testCases.length;

    // ApproximateTokenCounter should have significantly lower error
    expect(approximateAvgError).toBeLessThan(0.05); // < 5% error
    expect(fastAvgError).toBeGreaterThan(approximateAvgError);
  });

  it('should show FastTokenCounter is faster than ApproximateTokenCounter', () => {
    const longText = 'word '.repeat(10000); // 50000 chars

    const fastDuration = bestOf(() => fast.count(longText));
    const approximateDuration = bestOf(() => approximate.count(longText));

    // FastTokenCounter (bytes/4) should beat ApproximateTokenCounter (real BPE).
    expect(fastDuration).toBeLessThan(approximateDuration);
  });

  it('should document recommended padding factors', () => {
    // These are documented recommendations based on accuracy
    const recommendations = {
      fast: 0.8, // 80% of target (more safety margin)
      approximate: 0.9, // 90% of target (less safety margin)
    };

    // Verify our counters have the expected names
    expect(fast.name).toBe('fast');
    expect(approximate.name).toBe('approximate');

    // This test documents the relationship between accuracy and padding
    const fastAccuracy = 0.75; // ~75% accurate (bytes/4)
    const approximateAccuracy = 0.95; // ~95% accurate (gpt-tokenizer)

    expect(recommendations.fast).toBeLessThan(recommendations.approximate);
    expect(fastAccuracy).toBeLessThan(approximateAccuracy);
  });
});
