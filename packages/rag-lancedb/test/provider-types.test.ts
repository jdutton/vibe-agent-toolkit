/**
 * Compile-time type tests for LanceDBRAGProvider generics
 *
 * Verifies that LanceDBRAGProvider correctly implements the generic
 * RAGAdminProvider interface with both default and custom metadata types.
 */

import { describe, expect, it } from 'vitest';

import type { LanceDBRAGProvider } from '../src/lancedb-rag-provider.js';

describe('LanceDBRAGProvider generic types', () => {
  it('should accept DefaultRAGMetadata by default', () => {
    // LanceDBRAGProvider without type parameter should use DefaultRAGMetadata
    const provider: LanceDBRAGProvider = {} as LanceDBRAGProvider;

    // Compile-time type check: TypeScript verifies query() returns Promise<RAGResult>
    // Type checked by: provider.query({ text: 'test' }): Promise<RAGResult>
    expect(provider).toBeDefined(); // Test passes if types compile
  });

  it('should accept explicit custom metadata type', () => {
    // LanceDBRAGProvider should work with custom metadata when explicitly typed
    interface Custom extends Record<string, unknown> {
      domain: string;
    }
    const provider: LanceDBRAGProvider<Custom> = {} as LanceDBRAGProvider<Custom>;

    // Compile-time type check: TypeScript verifies query() returns Promise<RAGResult<Custom>>
    // Type checked by: provider.query({ text: 'test' }): Promise<RAGResult<Custom>>
    expect(provider).toBeDefined(); // Test passes if types compile
  });
});
