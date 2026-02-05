/**
 * Tests for RAGChunk schema
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';

import { RAGChunkSchema, createCustomRAGChunkSchema } from '../../src/schemas/chunk.js';
import type { RAGChunk } from '../../src/schemas/chunk.js';

describe('RAGChunkSchema', () => {
  // Test constants (to avoid duplication warnings)
  const TEST_CHUNK_ID = 'chunk-123';
  const TEST_RESOURCE_ID = 'resource-456';
  const TEST_EMBEDDING_MODEL = 'all-MiniLM-L6-v2';
  const TEST_CONTENT = 'Test content';
  const TEST_FILE_PATH = '/path/to/file.md';

  const validChunk: RAGChunk = {
    chunkId: TEST_CHUNK_ID,
    resourceId: TEST_RESOURCE_ID,
    content: 'This is a test chunk',
    contentHash: 'abc123',
    tokenCount: 5,
    filePath: TEST_FILE_PATH,
    embedding: [0.1, 0.2, 0.3],
    embeddingModel: TEST_EMBEDDING_MODEL,
    embeddedAt: new Date('2025-01-01'),
  };

  it('should validate a minimal valid chunk', () => {
    const result = RAGChunkSchema.safeParse(validChunk);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.chunkId).toBe('chunk-123');
      expect(result.data.content).toBe('This is a test chunk');
    }
  });

  it('should validate a chunk with optional fields', () => {
    const chunkWithOptionals: RAGChunk = {
      ...validChunk,
      headingPath: 'Architecture > RAG Design',
      headingLevel: 2,
      startLine: 10,
      endLine: 20,
      tags: ['rag', 'design'],
      type: 'documentation',
      title: 'RAG Design Document',
      previousChunkId: 'chunk-122',
      nextChunkId: 'chunk-124',
    };

    const result = RAGChunkSchema.safeParse(chunkWithOptionals);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.headingPath).toBe('Architecture > RAG Design');
      expect(result.data.tags).toEqual(['rag', 'design']);
    }
  });

  it('should reject chunk missing required fields', () => {
    const invalidChunk = {
      chunkId: 'chunk-123',
      // Missing required fields
    };

    const result = RAGChunkSchema.safeParse(invalidChunk);

    expect(result.success).toBe(false);
  });

  it('should reject chunk with invalid types', () => {
    const invalidChunk = {
      ...validChunk,
      tokenCount: 'not a number', // Wrong type
    };

    const result = RAGChunkSchema.safeParse(invalidChunk);

    expect(result.success).toBe(false);
  });

  it('should reject chunk with invalid embedding array', () => {
    const invalidChunk = {
      ...validChunk,
      embedding: ['not', 'numbers'], // Wrong type
    };

    const result = RAGChunkSchema.safeParse(invalidChunk);

    expect(result.success).toBe(false);
  });

  it('should have descriptive field descriptions', () => {
    const shape = RAGChunkSchema.shape;

    // Verify descriptions exist (checked via Zod schema metadata)
    expect(shape.chunkId.description).toBeTruthy();
    expect(shape.content.description).toBeTruthy();
    expect(shape.embedding.description).toBeTruthy();
  });

  describe('Schema composition', () => {
    it('should compose CoreRAGChunkSchema and DefaultRAGMetadataSchema', () => {
      const coreData = {
        chunkId: TEST_CHUNK_ID,
        resourceId: TEST_RESOURCE_ID,
        content: TEST_CONTENT,
        contentHash: 'abc123',
        tokenCount: 5,
        embedding: [0.1, 0.2, 0.3],
        embeddingModel: TEST_EMBEDDING_MODEL,
        embeddedAt: new Date(),
      };

      const metadataData = {
        filePath: TEST_FILE_PATH,
        tags: ['test'],
        type: 'documentation',
      };

      const fullChunk = { ...coreData, ...metadataData };
      const result = RAGChunkSchema.safeParse(fullChunk);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.chunkId).toBe(TEST_CHUNK_ID);
        expect(result.data.filePath).toBe(TEST_FILE_PATH);
        expect(result.data.tags).toEqual(['test']);
      }
    });

    it('should validate custom metadata schema composition', () => {
      const CustomMetadataSchema = z.object({
        domain: z.string(),
        category: z.string().optional(),
        priority: z.number(),
      });

      const CustomChunkSchema = createCustomRAGChunkSchema(CustomMetadataSchema);

      const customChunk = {
        chunkId: TEST_CHUNK_ID,
        resourceId: TEST_RESOURCE_ID,
        content: TEST_CONTENT,
        contentHash: 'abc123',
        tokenCount: 5,
        embedding: [0.1, 0.2, 0.3],
        embeddingModel: TEST_EMBEDDING_MODEL,
        embeddedAt: new Date(),
        domain: 'security',
        priority: 1,
      };

      const result = CustomChunkSchema.safeParse(customChunk);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.domain).toBe('security');
        expect(result.data.priority).toBe(1);
      }
    });

    it('should reject custom chunk missing custom fields', () => {
      const CustomMetadataSchema = z.object({
        domain: z.string(), // Required
      });

      const CustomChunkSchema = createCustomRAGChunkSchema(CustomMetadataSchema);

      const invalidChunk = {
        chunkId: TEST_CHUNK_ID,
        resourceId: TEST_RESOURCE_ID,
        content: TEST_CONTENT,
        contentHash: 'abc123',
        tokenCount: 5,
        embedding: [0.1, 0.2, 0.3],
        embeddingModel: TEST_EMBEDDING_MODEL,
        embeddedAt: new Date(),
        // Missing domain field
      };

      const result = CustomChunkSchema.safeParse(invalidChunk);

      expect(result.success).toBe(false);
    });
  });
});
