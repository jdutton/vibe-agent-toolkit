/**
 * Tests for token counter interface
 */

import { describe, expect, it } from 'vitest';

import type { TokenCounter } from '../../src/interfaces/token-counter.js';

describe('TokenCounter Interface', () => {
  it('should have required properties and methods', () => {
    // Type-only test - if this compiles, the interface is correct
    const mockCounter: TokenCounter = {
      name: 'test-counter',
      count: (_text: string): number => 0,
      countBatch: (_texts: string[]): number[] => [],
    };

    // Verify properties exist and have correct types
    expect(mockCounter.name).toBe('test-counter');
    expect(mockCounter.count).toBeDefined();
    expect(mockCounter.countBatch).toBeDefined();
  });

  it('should have count method that accepts string and returns number', () => {
    const mockCounter: TokenCounter = {
      name: 'test',
      count: (_text: string): number => 0,
      countBatch: (): number[] => [],
    };

    // Verify count method exists
    expect(mockCounter.count).toBeDefined();
    expect(typeof mockCounter.count).toBe('function');
  });

  it('should have countBatch method that accepts string[] and returns number[]', () => {
    const mockCounter: TokenCounter = {
      name: 'test',
      count: (): number => 0,
      countBatch: (_texts: string[]): number[] => [],
    };

    // Verify countBatch method exists
    expect(mockCounter.countBatch).toBeDefined();
    expect(typeof mockCounter.countBatch).toBe('function');
  });
});
