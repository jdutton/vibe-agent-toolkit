/**
 * Tests for ApproximateTokenCounter
 */

import { describe, expect, it } from 'vitest';

import { ApproximateTokenCounter } from '../../src/token-counters/approximate-token-counter.js';

import { testBatchCounting, testEmptyBatch } from './test-helpers.js';

describe('ApproximateTokenCounter', () => {
  const counter = new ApproximateTokenCounter();

  it('should have correct name', () => {
    expect(counter.name).toBe('approximate');
  });

  it('should count tokens accurately', () => {
    // Known token counts for GPT-3.5/GPT-4 tokenizer
    const testCases = [
      { text: 'Hello world', expectedTokens: 2 },
      { text: 'The quick brown fox', expectedTokens: 4 },
      { text: 'Hello, how are you?', expectedTokens: 6 },
    ];

    for (const { text, expectedTokens } of testCases) {
      const count = counter.count(text);
      expect(count).toBe(expectedTokens);
    }
  });

  it('should handle empty string', () => {
    expect(counter.count('')).toBe(0);
  });

  it('should handle multi-byte characters', () => {
    const text = '你好世界'; // Chinese characters
    const count = counter.count(text);

    // Chinese characters typically = 1-2 tokens each
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan(10);
  });

  it('should count batch of texts', () => {
    testBatchCounting(counter);
  });

  it('should handle empty batch', () => {
    testEmptyBatch(counter);
  });

  it('should be accurate within 5% for common text', () => {
    // Known token counts for GPT tokenizer
    const testCases = [
      { text: 'The quick brown fox jumps over the lazy dog', knownTokens: 9 },
      { text: 'Artificial intelligence is transforming the world', knownTokens: 7 },
      { text: 'TypeScript is a typed superset of JavaScript', knownTokens: 9 },
    ];

    for (const { text, knownTokens } of testCases) {
      const estimated = counter.count(text);
      const error = Math.abs(estimated - knownTokens) / knownTokens;

      // ApproximateTokenCounter should be very accurate (within 5%)
      expect(error).toBeLessThan(0.05);
    }
  });

  it('should handle long text efficiently', () => {
    const longText = 'word '.repeat(1000); // 5000 chars, ~1250 tokens
    const start = performance.now();
    const count = counter.count(longText);
    const duration = performance.now() - start;

    expect(count).toBeGreaterThan(1000);
    expect(duration).toBeLessThan(100); // Should be fast (< 100ms)
  });
});
