/**
 * Tests for admin-related schemas (RAGStats, IndexResult)
 */

import { describe, it, expect } from 'vitest';

import { RAGStatsSchema, IndexResultSchema } from '../../src/schemas/admin.js';
import type { RAGStats, IndexResult } from '../../src/schemas/admin.js';

const TEST_EMBEDDING_MODEL = 'all-MiniLM-L6-v2';

describe('RAGStatsSchema', () => {
  it('should validate valid stats', () => {
    const stats: RAGStats = {
      totalChunks: 1000,
      totalResources: 50,
      dbSizeBytes: 5000000,
      embeddingModel: TEST_EMBEDDING_MODEL,
      lastIndexed: new Date('2025-01-01'),
    };

    const result = RAGStatsSchema.safeParse(stats);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.totalChunks).toBe(1000);
      expect(result.data.embeddingModel).toBe(TEST_EMBEDDING_MODEL);
    }
  });

  it('should reject stats with missing required fields', () => {
    const stats = {
      totalChunks: 1000,
      // Missing other required fields
    };

    const result = RAGStatsSchema.safeParse(stats);

    expect(result.success).toBe(false);
  });

  it('should reject stats with invalid types', () => {
    const stats = {
      totalChunks: '1000', // Should be number
      totalResources: 50,
      dbSizeBytes: 5000000,
      embeddingModel: TEST_EMBEDDING_MODEL,
      lastIndexed: new Date('2025-01-01'),
    };

    const result = RAGStatsSchema.safeParse(stats);

    expect(result.success).toBe(false);
  });
});

describe('IndexResultSchema', () => {
  it('should validate successful indexing result', () => {
    const result: IndexResult = {
      resourcesIndexed: 10,
      resourcesSkipped: 5,
      resourcesUpdated: 3,
      chunksCreated: 100,
      chunksDeleted: 20,
      durationMs: 5000,
    };

    const parseResult = IndexResultSchema.safeParse(result);

    expect(parseResult.success).toBe(true);
    if (parseResult.success) {
      expect(parseResult.data.resourcesIndexed).toBe(10);
      expect(parseResult.data.durationMs).toBe(5000);
    }
  });

  it('should validate result with errors', () => {
    const result: IndexResult = {
      resourcesIndexed: 8,
      resourcesSkipped: 5,
      resourcesUpdated: 3,
      chunksCreated: 80,
      chunksDeleted: 20,
      durationMs: 5000,
      errors: [
        { resourceId: 'resource-1', error: 'Embedding failed' },
        { resourceId: 'resource-2', error: 'Token limit exceeded' },
      ],
    };

    const parseResult = IndexResultSchema.safeParse(result);

    expect(parseResult.success).toBe(true);
    if (parseResult.success) {
      expect(parseResult.data.errors).toHaveLength(2);
      expect(parseResult.data.errors?.[0]?.resourceId).toBe('resource-1');
    }
  });

  it('should reject result with missing required fields', () => {
    const result = {
      resourcesIndexed: 10,
      // Missing other required fields
    };

    const parseResult = IndexResultSchema.safeParse(result);

    expect(parseResult.success).toBe(false);
  });
});
