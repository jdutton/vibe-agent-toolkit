/**
 * Compile-time type tests for generic provider interfaces
 *
 * These tests verify that the generic provider interfaces work correctly
 * with default and custom metadata types using TypeScript's built-in type checking.
 */

import { describe, expect, it } from 'vitest';

import type {
  RAGAdminProvider,
  RAGQuery,
  RAGQueryProvider,
  RAGResult,
} from '../../src/interfaces/provider.js';

describe('Generic provider interface types', () => {
  it('should default to DefaultRAGMetadata', () => {
    // Compile-time type check: variable assignments validate types
    const provider: RAGQueryProvider = {} as RAGQueryProvider;
    const query: RAGQuery = { text: 'test' };

    // Verify types without runtime execution
    if (false as boolean) {
      const result: Promise<RAGResult> = provider.query(query);
      void result;
    }

    expect(true).toBe(true); // Test passes if code compiles
  });

  it('should support custom metadata type', () => {
    interface CustomMetadata extends Record<string, unknown> {
      domain: string;
      priority: number;
    }

    const provider: RAGQueryProvider<CustomMetadata> = {} as RAGQueryProvider<CustomMetadata>;
    const query: RAGQuery<CustomMetadata> = {
      text: 'test',
      filters: { metadata: { domain: 'security' } },
    };

    // Verify types without runtime execution
    if (false as boolean) {
      const result: Promise<RAGResult<CustomMetadata>> = provider.query(query);
      void result;
    }

    expect(true).toBe(true);
  });

  it('should support RAGAdminProvider with custom metadata', () => {
    interface CustomMetadata extends Record<string, unknown> {
      domain: string;
    }

    const provider: RAGAdminProvider<CustomMetadata> = {} as RAGAdminProvider<CustomMetadata>;

    // Verify types without runtime execution
    if (false as boolean) {
      const result: Promise<RAGResult<CustomMetadata>> = provider.query({ text: 'test' });
      void result;
    }

    expect(true).toBe(true);
  });
});
