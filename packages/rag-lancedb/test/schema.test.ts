/**
 * Tests for LanceDB schema mapping
 */

import type { RAGChunk } from '@vibe-agent-toolkit/rag';
import { describe, it, expect } from 'vitest';


import { chunkToLanceRow, lanceRowToChunk } from '../src/schema.js';

// Test constants
const TEST_CHUNK_ID = 'chunk-1';
const TEST_RESOURCE_ID = 'resource-1';
const TEST_FILE_PATH = '/test.md';
const TEST_MODEL = 'test-model';
const TEST_CONTENT_HASH = 'abc123';
const TEST_RESOURCE_CONTENT_HASH = 'def456';
const TEST_CONTENT = 'Test content';
const TEST_HEADING_PATH = 'Main > Sub';

describe('chunkToLanceRow', () => {
  it('should convert RAGChunk to LanceDB row format', () => {
    const chunk: RAGChunk = {
      chunkId: TEST_CHUNK_ID,
      resourceId: TEST_RESOURCE_ID,
      content: TEST_CONTENT,
      contentHash: TEST_CONTENT_HASH,
      tokenCount: 5,
      filePath: TEST_FILE_PATH,
      embedding: [0.1, 0.2, 0.3],
      embeddingModel: TEST_MODEL,
      embeddedAt: new Date('2025-01-01'),
      headingPath: TEST_HEADING_PATH,
      headingLevel: 2,
      tags: ['test', 'example'],
      type: 'documentation',
    };

    const row = chunkToLanceRow(chunk, TEST_RESOURCE_CONTENT_HASH);

    expect(row.chunkId).toBe(TEST_CHUNK_ID);
    expect(row.resourceId).toBe(TEST_RESOURCE_ID);
    expect(row.content).toBe(TEST_CONTENT);
    expect(row.contentHash).toBe(TEST_CONTENT_HASH);
    expect(row.resourceContentHash).toBe(TEST_RESOURCE_CONTENT_HASH);
    expect(row.vector).toEqual([0.1, 0.2, 0.3]);
    expect(row.embeddingModel).toBe(TEST_MODEL);
    expect(row.headingPath).toBe(TEST_HEADING_PATH);
    expect(row.tags).toBe('test,example'); // Comma-separated string
  });

  it('should handle optional fields', () => {
    const chunk: RAGChunk = {
      chunkId: TEST_CHUNK_ID,
      resourceId: TEST_RESOURCE_ID,
      content: 'Test',
      contentHash: TEST_CONTENT_HASH,
      tokenCount: 1,
      filePath: TEST_FILE_PATH,
      embedding: [0.1],
      embeddingModel: TEST_MODEL,
      embeddedAt: new Date(),
    };

    const row = chunkToLanceRow(chunk, TEST_RESOURCE_CONTENT_HASH);

    expect(row.headingPath).toBe(''); // Empty string for Arrow compatibility
    expect(row.headingLevel).toBe(-1); // -1 sentinel for Arrow compatibility
    expect(row.tags).toBe(''); // Empty string for Arrow compatibility
  });
});

describe('lanceRowToChunk', () => {
  it('should convert LanceDB row to RAGChunk', () => {
    const row = {
      chunkId: TEST_CHUNK_ID,
      resourceId: TEST_RESOURCE_ID,
      content: TEST_CONTENT,
      contentHash: TEST_CONTENT_HASH,
      resourceContentHash: TEST_RESOURCE_CONTENT_HASH,
      tokenCount: 5,
      filePath: TEST_FILE_PATH,
      vector: [0.1, 0.2, 0.3],
      embeddingModel: TEST_MODEL,
      embeddedAt: new Date('2025-01-01').getTime(),
      headingPath: TEST_HEADING_PATH,
      headingLevel: 2,
      tags: 'test,example', // Comma-separated string
      type: 'documentation',
    };

    const chunk = lanceRowToChunk(row);

    expect(chunk.chunkId).toBe(TEST_CHUNK_ID);
    expect(chunk.embedding).toEqual([0.1, 0.2, 0.3]);
    expect(chunk.embeddedAt).toBeInstanceOf(Date);
    expect(chunk.tags).toEqual(['test', 'example']);
  });

  it('should handle null optional fields', () => {
    const row = {
      chunkId: TEST_CHUNK_ID,
      resourceId: TEST_RESOURCE_ID,
      content: 'Test',
      contentHash: TEST_CONTENT_HASH,
      resourceContentHash: TEST_RESOURCE_CONTENT_HASH,
      tokenCount: 1,
      filePath: TEST_FILE_PATH,
      vector: [0.1],
      embeddingModel: TEST_MODEL,
      embeddedAt: Date.now(),
      headingPath: '',
      headingLevel: null,
      tags: '',
      type: '',
      title: '',
      startLine: null,
      endLine: null,
      previousChunkId: '',
      nextChunkId: '',
    };

    const chunk = lanceRowToChunk(row);

    expect(chunk.headingPath).toBeUndefined();
    expect(chunk.tags).toBeUndefined();
    expect(chunk.type).toBeUndefined();
    expect(chunk.title).toBeUndefined();
    expect(chunk.previousChunkId).toBeUndefined();
    expect(chunk.nextChunkId).toBeUndefined();
  });
});
