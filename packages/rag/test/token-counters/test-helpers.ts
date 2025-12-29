/**
 * Shared test helpers for token counter tests
 */

import { expect } from 'vitest';

import type { TokenCounter } from '../../src/interfaces/token-counter.js';

/**
 * Test helper for batch counting functionality
 */
export function testBatchCounting(counter: TokenCounter): void {
  const texts = ['Hello', 'world', 'test'];
  const results = counter.countBatch(texts);

  expect(results).toHaveLength(3);
  expect(results[0]).toBe(counter.count('Hello'));
  expect(results[1]).toBe(counter.count('world'));
  expect(results[2]).toBe(counter.count('test'));
}

/**
 * Test helper for empty batch handling
 */
export function testEmptyBatch(counter: TokenCounter): void {
  expect(counter.countBatch([])).toEqual([]);
}
