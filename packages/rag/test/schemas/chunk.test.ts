/**
 * Tests for RAGChunk schema
 */

import { describe, it, expect } from 'vitest';

import { RAGChunkSchema } from '../../src/schemas/chunk.js';
import type { RAGChunk } from '../../src/schemas/chunk.js';

describe('RAGChunkSchema', () => {
  const validChunk: RAGChunk = {
    chunkId: 'chunk-123',
    resourceId: 'resource-456',
    content: 'This is a test chunk',
    contentHash: 'abc123',
    tokenCount: 5,
    filePath: '/path/to/file.md',
    embedding: [0.1, 0.2, 0.3],
    embeddingModel: 'all-MiniLM-L6-v2',
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
});
