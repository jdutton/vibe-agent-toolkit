/**
 * Tests for RAG provider interfaces
 *
 * These tests verify interface contracts by checking TypeScript types compile correctly.
 */

import { describe, expect, it } from 'vitest';

import type { RAGAdminProvider, RAGQuery, RAGQueryProvider, RAGResult, RAGStats, IndexResult } from '../../src/interfaces/provider.js';

describe('RAGQueryProvider Interface', () => {
  it('should have query method that accepts RAGQuery and returns Promise<RAGResult>', () => {
    // Type-only test - if this compiles, the interface is correct
    const mockProvider: RAGQueryProvider = {
      query: (_query: RAGQuery): Promise<RAGResult> => Promise.resolve({} as RAGResult),
      getStats: (): Promise<RAGStats> => Promise.resolve({} as RAGStats),
    };

    // Verify the query method exists and accepts RAGQuery
    expect(mockProvider.query).toBeDefined();
    expect(typeof mockProvider.query).toBe('function');
  });

  it('should have getStats method that returns Promise<RAGStats>', () => {
    // Type-only test
    const mockProvider: RAGQueryProvider = {
      query: (): Promise<RAGResult> => Promise.resolve({} as RAGResult),
      getStats: (): Promise<RAGStats> => Promise.resolve({} as RAGStats),
    };

    expect(mockProvider.getStats).toBeDefined();
    expect(typeof mockProvider.getStats).toBe('function');
  });
});

describe('RAGAdminProvider Interface', () => {
  it('should extend RAGQueryProvider and have admin methods', () => {
    // Type-only test - verify RAGAdminProvider extends RAGQueryProvider
    const mockProvider: RAGAdminProvider = {
      // RAGQueryProvider methods
      query: (): Promise<RAGResult> => Promise.resolve({} as RAGResult),
      getStats: (): Promise<RAGStats> => Promise.resolve({} as RAGStats),
      // RAGAdminProvider methods
      indexResources: (): Promise<IndexResult> => Promise.resolve({} as IndexResult),
      updateResource: (): Promise<void> => Promise.resolve(),
      deleteResource: (): Promise<void> => Promise.resolve(),
      clear: (): Promise<void> => Promise.resolve(),
      close: (): Promise<void> => Promise.resolve(),
    };

    // Verify it has all required methods
    expect(mockProvider.query).toBeDefined();
    expect(mockProvider.getStats).toBeDefined();
    expect(mockProvider.indexResources).toBeDefined();
    expect(mockProvider.updateResource).toBeDefined();
    expect(mockProvider.deleteResource).toBeDefined();
    expect(mockProvider.clear).toBeDefined();
    expect(mockProvider.close).toBeDefined();
  });
});
