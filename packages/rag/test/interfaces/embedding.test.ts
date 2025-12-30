/**
 * Tests for embedding provider interface
 */

import { describe, expect, it } from 'vitest';

import type { EmbeddingProvider } from '../../src/interfaces/embedding.js';

describe('EmbeddingProvider Interface', () => {
  it('should have required properties and methods', () => {
    // Type-only test - if this compiles, the interface is correct
    const mockProvider: EmbeddingProvider = {
      name: 'test-provider',
      model: 'test-model',
      dimensions: 384,
      embed: (_text: string): Promise<number[]> => Promise.resolve([]),
      embedBatch: (_texts: string[]): Promise<number[][]> => Promise.resolve([]),
    };

    // Verify properties exist and have correct types
    expect(mockProvider.name).toBe('test-provider');
    expect(mockProvider.model).toBe('test-model');
    expect(mockProvider.dimensions).toBe(384);
    expect(mockProvider.embed).toBeDefined();
    expect(mockProvider.embedBatch).toBeDefined();
  });

  it('should have embed method that accepts string and returns Promise<number[]>', () => {
    const mockProvider: EmbeddingProvider = {
      name: 'test',
      model: 'test',
      dimensions: 384,
      embed: (_text: string): Promise<number[]> => Promise.resolve([]),
      embedBatch: (): Promise<number[][]> => Promise.resolve([]),
    };

    // Verify embed method exists
    expect(mockProvider.embed).toBeDefined();
    expect(typeof mockProvider.embed).toBe('function');
  });

  it('should have embedBatch method that accepts string[] and returns Promise<number[][]>', () => {
    const mockProvider: EmbeddingProvider = {
      name: 'test',
      model: 'test',
      dimensions: 384,
      embed: (): Promise<number[]> => Promise.resolve([]),
      embedBatch: (_texts: string[]): Promise<number[][]> => Promise.resolve([]),
    };

    // Verify embedBatch method exists
    expect(mockProvider.embedBatch).toBeDefined();
    expect(typeof mockProvider.embedBatch).toBe('function');
  });
});
