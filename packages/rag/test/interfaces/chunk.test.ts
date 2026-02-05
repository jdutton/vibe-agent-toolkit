/**
 * Tests for RAGChunk interface composition
 */

import { describe, it, expectTypeOf } from 'vitest';

import type { CoreRAGChunk, DefaultRAGMetadata, RAGChunk } from '../../src/interfaces/index.js';

describe('RAGChunk interface composition', () => {
  it('should compose CoreRAGChunk and DefaultRAGMetadata', () => {
    const coreChunk: CoreRAGChunk = {
      chunkId: 'chunk-123',
      resourceId: 'resource-456',
      content: 'Test content',
      contentHash: 'abc123',
      tokenCount: 5,
      embedding: [0.1, 0.2, 0.3],
      embeddingModel: 'all-MiniLM-L6-v2',
      embeddedAt: new Date(),
    };

    const metadata: DefaultRAGMetadata = {
      filePath: '/path/to/file.md',
      tags: ['test'],
      type: 'documentation',
    };

    const chunk: RAGChunk = { ...coreChunk, ...metadata };

    // Verify composition works - RAGChunk should be assignable to its component types
    expectTypeOf(chunk).toEqualTypeOf<CoreRAGChunk & DefaultRAGMetadata>();
    expectTypeOf(chunk).toEqualTypeOf<RAGChunk>();
  });

  it('should have all core fields', () => {
    const chunk = {} as RAGChunk;

    // Core fields should exist
    expectTypeOf(chunk.chunkId).toBeString();
    expectTypeOf(chunk.resourceId).toBeString();
    expectTypeOf(chunk.content).toBeString();
    expectTypeOf(chunk.contentHash).toBeString();
    expectTypeOf(chunk.tokenCount).toBeNumber();
    expectTypeOf(chunk.embedding).toEqualTypeOf<number[]>();
    expectTypeOf(chunk.embeddingModel).toBeString();
    expectTypeOf(chunk.embeddedAt).toEqualTypeOf<Date>();
    expectTypeOf(chunk.previousChunkId).toEqualTypeOf<string | undefined>();
    expectTypeOf(chunk.nextChunkId).toEqualTypeOf<string | undefined>();
  });

  it('should have all default metadata fields', () => {
    const chunk = {} as RAGChunk;

    // Default metadata fields should exist
    expectTypeOf(chunk.filePath).toBeString();
    expectTypeOf(chunk.tags).toEqualTypeOf<string[] | undefined>();
    expectTypeOf(chunk.type).toEqualTypeOf<string | undefined>();
    expectTypeOf(chunk.title).toEqualTypeOf<string | undefined>();
    expectTypeOf(chunk.headingPath).toEqualTypeOf<string | undefined>();
    expectTypeOf(chunk.headingLevel).toEqualTypeOf<number | undefined>();
    expectTypeOf(chunk.startLine).toEqualTypeOf<number | undefined>();
    expectTypeOf(chunk.endLine).toEqualTypeOf<number | undefined>();
  });

  it('should support custom metadata composition', () => {
    interface CustomMetadata {
      domain: string;
      category?: string;
      priority: number;
    }

    type CustomChunk = CoreRAGChunk & CustomMetadata;

    const chunk = {} as CustomChunk;

    // Should have core fields
    expectTypeOf(chunk.chunkId).toBeString();
    expectTypeOf(chunk.content).toBeString();

    // Should have custom fields
    expectTypeOf(chunk.domain).toBeString();
    expectTypeOf(chunk.category).toEqualTypeOf<string | undefined>();
    expectTypeOf(chunk.priority).toBeNumber();

    // Should NOT have default metadata fields
    // @ts-expect-error - filePath not in CustomMetadata
    chunk.filePath;
  });
});
