/**
 * Tests for RAGQuery and RAGResult schemas
 */

import { describe, it, expect } from 'vitest';

import { RAGQuerySchema, RAGResultSchema } from '../../src/schemas/query.js';
import type { RAGQuery, RAGResult } from '../../src/schemas/query.js';

const TEST_SEARCH_TERM = 'search term';

describe('RAGQuerySchema', () => {
  it('should validate minimal query with just text', () => {
    const query: RAGQuery = {
      text: 'How do I validate schemas?',
    };

    const result = RAGQuerySchema.safeParse(query);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.text).toBe('How do I validate schemas?');
    }
  });

  it('should validate query with limit', () => {
    const query: RAGQuery = {
      text: TEST_SEARCH_TERM,
      limit: 10,
    };

    const result = RAGQuerySchema.safeParse(query);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(10);
    }
  });

  /**
   * ⚠️ Parsing is not support. This schema validates STRUCTURE; whether a provider
   * can honour a field is a separate question, answered by
   * `assertFiltersAreSupported` in `@vibe-agent-toolkit/rag-lancedb` and pinned by
   * that package's `unsupported-filters` / `unsupported-query` suites.
   *
   * `tags`, `type`, `headingPath` and `hybridSearch.enabled: true` all parse here and
   * are all REFUSED at `query()`. Do not read a green assertion below as evidence that
   * one of them works — this file never constructs a provider, so it is structurally
   * incapable of seeing that a filtered query returned the whole corpus. That blindness
   * is exactly how the widening defect survived a green suite.
   */
  it('should validate query with filters', () => {
    const query: RAGQuery = {
      text: TEST_SEARCH_TERM,
      filters: {
        resourceId: 'resource-123',
        tags: ['validation', 'schema'],
        type: 'documentation',
        headingPath: 'Architecture > RAG',
      },
    };

    const result = RAGQuerySchema.safeParse(query);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.filters?.tags).toEqual(['validation', 'schema']);
      expect(result.data.filters?.type).toBe('documentation');
    }
  });

  it('should preserve filters.metadata rather than stripping it', () => {
    // A Zod object strips unknown keys instead of rejecting them, so before this
    // schema declared `metadata`, the ONE filter path a provider honours was silently
    // discarded by validating against the schema that is supposed to describe it.
    const query: RAGQuery = {
      text: TEST_SEARCH_TERM,
      filters: { metadata: { domain: 'security', priority: 1 } },
    };

    const result = RAGQuerySchema.safeParse(query);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.filters?.metadata).toEqual({ domain: 'security', priority: 1 });
    }
  });

  it('should validate query with hybridSearch config', () => {
    const query: RAGQuery = {
      text: TEST_SEARCH_TERM,
      hybridSearch: {
        enabled: true,
        keywordWeight: 0.3,
      },
    };

    const result = RAGQuerySchema.safeParse(query);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.hybridSearch?.enabled).toBe(true);
      expect(result.data.hybridSearch?.keywordWeight).toBeCloseTo(0.3, 10);
    }
  });

  it('should reject query with missing text', () => {
    const query = {
      limit: 10,
    };

    const result = RAGQuerySchema.safeParse(query);

    expect(result.success).toBe(false);
  });
});

describe('RAGResultSchema', () => {
  it('should validate result with chunks and stats', () => {
    const result: RAGResult = {
      chunks: [
        {
          chunkId: 'chunk-1',
          resourceId: 'resource-1',
          content: 'Test content',
          contentHash: 'hash123',
          tokenCount: 3,
          filePath: '/test.md',
          embedding: [0.1, 0.2],
          embeddingModel: 'test-model',
          embeddedAt: new Date('2025-01-01'),
        },
      ],
      stats: {
        totalMatches: 5,
        searchDurationMs: 100,
      },
    };

    const parseResult = RAGResultSchema.safeParse(result);

    expect(parseResult.success).toBe(true);
    if (parseResult.success) {
      expect(parseResult.data.chunks).toHaveLength(1);
      expect(parseResult.data.stats.totalMatches).toBe(5);
    }
  });

  it('should validate result with embedding stats', () => {
    const result: RAGResult = {
      chunks: [],
      stats: {
        totalMatches: 0,
        searchDurationMs: 50,
        embedding: {
          model: 'text-embedding-3-small',
          tokensUsed: 100,
        },
      },
    };

    const parseResult = RAGResultSchema.safeParse(result);

    expect(parseResult.success).toBe(true);
    if (parseResult.success) {
      expect(parseResult.data.stats.embedding?.model).toBe('text-embedding-3-small');
      expect(parseResult.data.stats.embedding?.tokensUsed).toBe(100);
    }
  });

  it('should reject result with invalid chunk structure', () => {
    const result = {
      chunks: [
        { invalid: 'chunk' }, // Missing required fields
      ],
      stats: {
        totalMatches: 1,
        searchDurationMs: 100,
      },
    };

    const parseResult = RAGResultSchema.safeParse(result);

    expect(parseResult.success).toBe(false);
  });
});
