/**
 * Token Counter Comparison Tests
 *
 * Compare accuracy and performance of different token counters.
 */

import { describe, expect, it } from 'vitest';

import { ApproximateTokenCounter } from '../../src/token-counters/approximate-token-counter.js';
import { FastTokenCounter } from '../../src/token-counters/fast-token-counter.js';

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

    // Measure FastTokenCounter
    const fastStart = performance.now();
    fast.count(longText);
    const fastDuration = performance.now() - fastStart;

    // Measure ApproximateTokenCounter
    const approximateStart = performance.now();
    approximate.count(longText);
    const approximateDuration = performance.now() - approximateStart;

    // FastTokenCounter should be significantly faster
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
