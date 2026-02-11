/**
 * Tests for resource chunking
 */

import { describe, expect, it } from 'vitest';

import type { ChunkableResource } from '../../src/chunking/chunk-resource.js';
import { chunkResource, enrichChunks } from '../../src/chunking/chunk-resource.js';
import { ApproximateTokenCounter } from '../../src/token-counters/approximate-token-counter.js';

describe('chunkResource', () => {
  const tokenCounter = new ApproximateTokenCounter();
  const TEST_RESOURCE_ID = 'test-resource';

  it('should chunk simple markdown resource', () => {
    const resource: ChunkableResource = {
      id: TEST_RESOURCE_ID,
      filePath: '/test.md',
      content: '# Heading 1\n\nContent under heading 1.\n\n## Heading 2\n\nContent under heading 2.',
      contentHash: 'abc123',
      estimatedTokenCount: 20,
      links: [],
      headings: [
        {
          level: 1,
          text: 'Heading 1',
          slug: 'heading-1',
          line: 1,
        },
        {
          level: 2,
          text: 'Heading 2',
          slug: 'heading-2',
          line: 5,
        },
      ],
      frontmatter: {},
    };

    const config = {
      targetChunkSize: 512,
      modelTokenLimit: 8191,
      paddingFactor: 0.9,
      tokenCounter,
    };

    const result = chunkResource(resource, config);

    expect(result.chunks.length).toBeGreaterThan(0);
    expect(result.stats.totalChunks).toBe(result.chunks.length);

    // Check chunk structure
    for (const chunk of result.chunks) {
      expect(chunk.content).toBeTruthy();
      expect(typeof chunk.content).toBe('string');
    }
  });

  it('should preserve heading paths', () => {
    const resource: ChunkableResource = {
      id: TEST_RESOURCE_ID,
      filePath: '/test.md',
      content: '# Main\n\nContent.\n\n## Sub\n\nMore content.',
      contentHash: 'abc123',
      estimatedTokenCount: 15,
      links: [],
      headings: [
        {
          level: 1,
          text: 'Main',
          slug: 'main',
          line: 1,
        },
        {
          level: 2,
          text: 'Sub',
          slug: 'sub',
          line: 5,
        },
      ],
      frontmatter: {},
    };

    const config = {
      targetChunkSize: 512,
      modelTokenLimit: 8191,
      paddingFactor: 0.9,
      tokenCounter,
    };

    const result = chunkResource(resource, config);

    // Should have chunks with heading paths
    const chunksWithHeadings = result.chunks.filter((c) => c.headingPath);
    expect(chunksWithHeadings.length).toBeGreaterThan(0);
  });

  it('should create multiple chunks from multiple headings', () => {
    const resource: ChunkableResource = {
      id: TEST_RESOURCE_ID,
      filePath: '/test.md',
      content: '# H1\n\nContent 1.\n\n# H2\n\nContent 2.\n\n# H3\n\nContent 3.',
      contentHash: 'abc123',
      estimatedTokenCount: 20,
      links: [],
      headings: [
        { level: 1, text: 'H1', slug: 'h1', line: 1 },
        { level: 1, text: 'H2', slug: 'h2', line: 5 },
        { level: 1, text: 'H3', slug: 'h3', line: 9 },
      ],
      frontmatter: {},
    };

    const config = {
      targetChunkSize: 512,
      modelTokenLimit: 8191,
      paddingFactor: 0.9,
      tokenCounter,
    };

    const result = chunkResource(resource, config);

    // Should create multiple chunks (one per heading section)
    expect(result.chunks.length).toBeGreaterThanOrEqual(3);

    // Each chunk should have content
    for (const chunk of result.chunks) {
      expect(chunk.content.trim().length).toBeGreaterThan(0);
    }
  });

  it('should handle resource with no headings', () => {
    const resource: ChunkableResource = {
      id: TEST_RESOURCE_ID,
      filePath: '/test.md',
      content: 'Plain text without headings.',
      contentHash: 'abc123',
      estimatedTokenCount: 10,
      links: [],
      headings: [],
      frontmatter: {},
    };

    const config = {
      targetChunkSize: 512,
      modelTokenLimit: 8191,
      paddingFactor: 0.9,
      tokenCounter,
    };

    const result = chunkResource(resource, config);

    expect(result.chunks.length).toBe(1);
    expect(result.chunks[0]?.content).toBe('Plain text without headings.');
  });

  it('should calculate accurate statistics', () => {
    const resource: ChunkableResource = {
      id: TEST_RESOURCE_ID,
      filePath: '/test.md',
      content: '# H1\n\nShort content.',
      contentHash: 'abc123',
      estimatedTokenCount: 10,
      links: [],
      headings: [{ level: 1, text: 'H1', slug: 'h1', line: 1 }],
      frontmatter: {},
    };

    const config = {
      targetChunkSize: 512,
      modelTokenLimit: 8191,
      paddingFactor: 0.9,
      tokenCounter,
    };

    const result = chunkResource(resource, config);

    expect(result.stats.totalChunks).toBe(result.chunks.length);
    expect(result.stats.averageTokens).toBeGreaterThan(0);
    expect(result.stats.maxTokens).toBeGreaterThanOrEqual(result.stats.averageTokens);
    expect(result.stats.minTokens).toBeLessThanOrEqual(result.stats.averageTokens);
  });
});

describe('enrichChunks', () => {
  const TEST_RESOURCE_ID = 'test-resource';
  const TEST_MODEL = 'test-model';
  const TEST_FILE_PATH = '/test.md';

  /** Create a minimal ChunkableResource for enrichChunks tests */
  function createResource(overrides?: Partial<ChunkableResource>): ChunkableResource {
    return {
      id: TEST_RESOURCE_ID,
      filePath: TEST_FILE_PATH,
      content: 'Test content',
      contentHash: 'abc123',
      estimatedTokenCount: 10,
      links: [],
      headings: [],
      frontmatter: {},
      ...overrides,
    };
  }

  it('should enrich raw chunks with RAGChunk metadata', () => {
    const resource = createResource({ frontmatter: { tags: ['test'], title: 'Test' } });

    const rawChunks = [
      { content: 'Chunk 1', headingPath: 'Section 1', headingLevel: 1 },
      { content: 'Chunk 2', headingPath: 'Section 2', headingLevel: 1 },
      { content: 'Chunk 3', headingPath: 'Section 3', headingLevel: 1 },
    ];

    const embeddings = [[0.1, 0.2], [0.3, 0.4], [0.5, 0.6]];

    const enriched = enrichChunks(rawChunks, resource, embeddings, TEST_MODEL);

    expect(enriched).toHaveLength(3);

    // Check first chunk
    expect(enriched[0]).toMatchObject({
      chunkId: `${TEST_RESOURCE_ID}-chunk-0`,
      resourceId: TEST_RESOURCE_ID,
      content: 'Chunk 1',
      filePath: TEST_FILE_PATH,
      tags: ['test'],
      title: 'Test',
      embeddingModel: TEST_MODEL,
      previousChunkId: undefined,
      nextChunkId: `${TEST_RESOURCE_ID}-chunk-1`,
    });

    // Check middle chunk
    expect(enriched[1]).toMatchObject({
      chunkId: `${TEST_RESOURCE_ID}-chunk-1`,
      previousChunkId: `${TEST_RESOURCE_ID}-chunk-0`,
      nextChunkId: `${TEST_RESOURCE_ID}-chunk-2`,
    });

    // Check last chunk
    expect(enriched[2]).toMatchObject({
      chunkId: `${TEST_RESOURCE_ID}-chunk-2`,
      previousChunkId: `${TEST_RESOURCE_ID}-chunk-1`,
      nextChunkId: undefined,
    });
  });

  it('should set tokenCount to 0 when no tokenCounter is provided', () => {
    const resource = createResource();
    const rawChunks = [
      { content: 'Some text content here' },
      { content: 'More text content here' },
    ];
    const embeddings = [[0.1, 0.2], [0.3, 0.4]];

    const enriched = enrichChunks(rawChunks, resource, embeddings, TEST_MODEL);

    expect(enriched[0]?.tokenCount).toBe(0);
    expect(enriched[1]?.tokenCount).toBe(0);
  });

  it('should populate tokenCount when tokenCounter is provided', () => {
    const resource = createResource();
    const rawChunks = [
      { content: 'Some text content here' },
      { content: 'A longer piece of text content that should have more tokens than the first chunk' },
    ];
    const embeddings = [[0.1, 0.2], [0.3, 0.4]];

    const counter = new ApproximateTokenCounter();
    const enriched = enrichChunks(rawChunks, resource, embeddings, TEST_MODEL, counter);

    // Token counts should be positive (not the default 0)
    expect(enriched[0]?.tokenCount).toBeGreaterThan(0);
    expect(enriched[1]?.tokenCount).toBeGreaterThan(0);

    // Token counts should match what the counter returns directly
    expect(enriched[0]?.tokenCount).toBe(counter.count(rawChunks[0]?.content ?? ''));
    expect(enriched[1]?.tokenCount).toBe(counter.count(rawChunks[1]?.content ?? ''));

    // Second chunk should have more tokens than the first
    expect(enriched[1]?.tokenCount).toBeGreaterThan(enriched[0]?.tokenCount ?? 0);
  });

  it('should populate chunkIndex and totalChunks', () => {
    const resource = createResource();
    const rawChunks = [{ content: 'A' }, { content: 'B' }, { content: 'C' }];
    const embeddings = [[1], [2], [3]];

    const enriched = enrichChunks(rawChunks, resource, embeddings, TEST_MODEL);

    expect(enriched).toHaveLength(3);
    for (const [i, chunk] of enriched.entries()) {
      expect(chunk.chunkIndex).toBe(i);
      expect(chunk.totalChunks).toBe(3);
    }
  });

  it('should handle single chunk correctly', () => {
    const resource = createResource({ content: 'Test', estimatedTokenCount: 5 });
    const rawChunks = [{ content: 'Single chunk' }];
    const embeddings = [[0.1, 0.2]];

    const enriched = enrichChunks(rawChunks, resource, embeddings, TEST_MODEL);

    expect(enriched).toHaveLength(1);
    expect(enriched[0]?.previousChunkId).toBeUndefined();
    expect(enriched[0]?.nextChunkId).toBeUndefined();
    expect(enriched[0]?.chunkIndex).toBe(0);
    expect(enriched[0]?.totalChunks).toBe(1);
  });
});
