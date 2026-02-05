/**
 * Compile-time type tests for LanceDBRAGProvider generics
 *
 * Verifies that LanceDBRAGProvider correctly implements the generic
 * RAGAdminProvider interface with both default and custom metadata types.
 */

import type { RAGResult } from '@vibe-agent-toolkit/rag';
import { describe, expect, it } from 'vitest';

import type { LanceDBRAGProvider } from '../src/lancedb-rag-provider.js';

describe('LanceDBRAGProvider generic types', () => {
  it('should accept DefaultRAGMetadata by default', () => {
    // LanceDBRAGProvider without type parameter should use DefaultRAGMetadata
    const provider: LanceDBRAGProvider = {} as LanceDBRAGProvider;

    // Verify types without runtime execution
    if (false as boolean) {
      const result: Promise<RAGResult> = provider.query({ text: 'test' });
      void result;
    }

    expect(true).toBe(true); // Passes if compiles
  });

  it('should accept explicit custom metadata type', () => {
    // LanceDBRAGProvider should work with custom metadata when explicitly typed
    interface Custom extends Record<string, unknown> {
      domain: string;
    }
    const provider: LanceDBRAGProvider<Custom> = {} as LanceDBRAGProvider<Custom>;

    // Verify types without runtime execution
    if (false as boolean) {
      const result: Promise<RAGResult<Custom>> = provider.query({ text: 'test' });
      void result;
    }

    expect(true).toBe(true);
  });
});
