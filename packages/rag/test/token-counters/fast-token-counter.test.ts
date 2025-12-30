/**
 * Tests for FastTokenCounter
 */

import { describe, expect, it } from 'vitest';

import { FastTokenCounter } from '../../src/token-counters/fast-token-counter.js';

import { testBatchCounting, testEmptyBatch } from './test-helpers.js';

describe('FastTokenCounter', () => {
  const counter = new FastTokenCounter();

  it('should have correct name', () => {
    expect(counter.name).toBe('fast');
  });

  it('should count tokens using bytes/4 heuristic', () => {
    const text = 'Hello world';
    const bytes = new TextEncoder().encode(text).length;
    const expectedTokens = Math.ceil(bytes / 4);

    expect(counter.count(text)).toBe(expectedTokens);
  });

  it('should handle empty string', () => {
    expect(counter.count('')).toBe(0);
  });

  it('should handle multi-byte characters', () => {
    const text = '你好世界'; // Chinese characters (3 bytes each in UTF-8)
    const bytes = new TextEncoder().encode(text).length;
    const expectedTokens = Math.ceil(bytes / 4);

    expect(counter.count(text)).toBe(expectedTokens);
  });

  it('should count batch of texts', () => {
    testBatchCounting(counter);
  });

  it('should handle empty batch', () => {
    testEmptyBatch(counter);
  });

  it('should be approximately 25% accurate (bytes/4)', () => {
    // Known token counts for common text (from OpenAI tokenizer)
    const testCases = [
      { text: 'The quick brown fox', knownTokens: 4, tolerance: 0.5 },
      { text: 'Hello world!', knownTokens: 3, tolerance: 0.5 },
    ];

    for (const { text, knownTokens, tolerance } of testCases) {
      const estimated = counter.count(text);
      const error = Math.abs(estimated - knownTokens) / knownTokens;

      // FastTokenCounter is rough - just verify it doesn't wildly overestimate
      expect(error).toBeLessThan(tolerance);
    }
  });
});
