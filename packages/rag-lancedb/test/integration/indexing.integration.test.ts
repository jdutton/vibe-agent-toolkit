/**
 * Integration tests for LanceDB RAG provider
 *
 * These tests use real LanceDB and TransformersEmbeddingProvider to verify:
 * - Admin operations (indexing, deletion, clearing)
 * - Query operations (semantic search, filtering)
 * - Statistics and database management
 * - Error handling and edge cases
 *
 * NOTE: Tests for multi-resource indexing and change detection are covered by
 * CLI system tests in test/system/cli-dogfooding.system.test.ts, which use
 * Node.js runtime to avoid Bun + Apache Arrow buffer issues.
 *
 * Related Issues:
 * - Apache Arrow buffer issues: https://github.com/apache/arrow/issues/35355
 * - LanceDB JS issues: https://github.com/lancedb/lancedb/issues/882
 * - Arrow memory docs: https://arrow.apache.org/docs/python/api/memory.html
 *
 * The "Buffer is already detached" error occurs in Bun when querying LanceDB
 * after table modifications. This is a Bun-specific runtime issue, not a logic
 * error. The code works correctly in Node.js and in production where provider
 * connections are long-lived.
 */

import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LanceDBRAGProvider } from '../../src/lancedb-rag-provider.js';
import { createTempDir, createTestMarkdownFile, createTestResource } from '../test-helpers.js';

describe('LanceDB Indexing Integration', () => {
  const SPECIFIC_RESOURCE_ID = 'specific-resource-id';

  let tempDir: string;
  let dbPath: string;
  let testFilePath: string;
  let provider: LanceDBRAGProvider;

  beforeEach(async () => {
    // Create temporary directory for test database and files
    tempDir = await createTempDir();
    dbPath = join(tempDir, 'db');

    // Create a test markdown file
    testFilePath = await createTestMarkdownFile(
      tempDir,
      'test.md',
      `# Test Document

This is a test document for RAG indexing.

## Section 1

Some content in section 1.

## Section 2

More content in section 2.`
    );
  });

  afterEach(async () => {
    if (provider) {
      await provider.close();
    }
    // Clean up temporary directory
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should index a simple resource', async () => {
    provider = await LanceDBRAGProvider.create({ dbPath });

    // Create test resource
    const resource = await createTestResource(testFilePath);

    const result = await provider.indexResources([resource]);

    // Debug: Print errors if any
    if (result.errors && result.errors.length > 0) {
      console.error('Indexing errors:', result.errors);
    }

    expect(result.errors).toEqual([]);
    expect(result.resourcesIndexed).toBe(1);
    expect(result.chunksCreated).toBeGreaterThan(0);
  });

  it('should query indexed resources', async () => {
    provider = await LanceDBRAGProvider.create({ dbPath });

    // Create and index test resource
    const resource = await createTestResource(testFilePath);
    await provider.indexResources([resource]);

    // Query
    const queryResult = await provider.query({
      text: 'test document',
      limit: 5,
    });

    expect(queryResult.chunks).toBeDefined();
    expect(queryResult.chunks.length).toBeGreaterThan(0);
    expect(queryResult.stats.totalMatches).toBeGreaterThan(0);
  });


  it('should get database statistics', async () => {
    provider = await LanceDBRAGProvider.create({ dbPath });

    // Create and index test resource
    const resource = await createTestResource(testFilePath);
    await provider.indexResources([resource]);

    const stats = await provider.getStats();

    expect(stats.totalChunks).toBeGreaterThan(0);
    expect(stats.totalResources).toBe(1);
    expect(stats.embeddingModel).toBeTruthy();
  });

  it('should throw error when querying empty database', async () => {
    provider = await LanceDBRAGProvider.create({ dbPath });

    await expect(provider.query({ text: 'test' })).rejects.toThrow('No data indexed yet');
  });

  it('should enforce readonly mode', async () => {
    provider = await LanceDBRAGProvider.create({ dbPath });

    // Create and index test resource
    const resource = await createTestResource(testFilePath);
    await provider.indexResources([resource]);
    await provider.close();

    // Reopen in readonly mode
    provider = await LanceDBRAGProvider.create({ dbPath, readonly: true });

    // Should be able to query
    const result = await provider.query({ text: 'test' });
    expect(result.chunks).toBeDefined();

    // Should not be able to index
    // eslint-disable-next-line sonarjs/no-duplicate-string -- Test assertions are clearer with inline strings
    await expect(provider.indexResources([resource])).rejects.toThrow('readonly mode');

    // Should not be able to delete
    await expect(provider.deleteResource('test-1')).rejects.toThrow('readonly mode');

    // Should not be able to clear
    await expect(provider.clear()).rejects.toThrow('readonly mode');
  });


  it('should clear database', async () => {
    provider = await LanceDBRAGProvider.create({ dbPath });

    // Index a resource
    const resource = await createTestResource(testFilePath);
    await provider.indexResources([resource]);

    // Verify data exists
    let stats = await provider.getStats();
    expect(stats.totalChunks).toBeGreaterThan(0);
    expect(stats.totalResources).toBe(1);

    // Clear database
    await provider.clear();

    // Verify empty
    stats = await provider.getStats();
    expect(stats.totalChunks).toBe(0);
    expect(stats.totalResources).toBe(0);

    // Query should fail on empty DB
    await expect(provider.query({ text: 'test' })).rejects.toThrow('No data indexed yet');
  });


  it('should respect limit parameter in queries', async () => {
    provider = await LanceDBRAGProvider.create({ dbPath });

    // Create a document with multiple chunks
    const largePath = await createTestMarkdownFile(
      tempDir,
      'large.md',
      `# Large Document

## Section 1
Content for section 1 with lots of text to create multiple chunks.

## Section 2
Content for section 2 with more text.

## Section 3
Content for section 3 with additional text.

## Section 4
Content for section 4 with even more text.`
    );

    const resource = await createTestResource(largePath);
    await provider.indexResources([resource]);

    // Query with limit
    const result = await provider.query({ text: 'content', limit: 2 });
    expect(result.chunks.length).toBeLessThanOrEqual(2);
  });

  it('should filter queries by single resourceId', async () => {
    provider = await LanceDBRAGProvider.create({ dbPath });

    const resource = await createTestResource(testFilePath, SPECIFIC_RESOURCE_ID);
    await provider.indexResources([resource]);

    // Query with resourceId filter
    const result = await provider.query({
      text: 'content',
      filters: { resourceId: SPECIFIC_RESOURCE_ID },
    });

    expect(result.chunks.every(chunk => chunk.resourceId === SPECIFIC_RESOURCE_ID)).toBe(true);
  });

  // @ts-expect-error - Bun global is available at runtime
  it.skipIf(typeof Bun !== 'undefined')(
    'should handle empty resourceId filter array',
    async () => {
      provider = await LanceDBRAGProvider.create({ dbPath });

      const resource = await createTestResource(testFilePath);
      await provider.indexResources([resource]);

      // Close and reopen to avoid Bun + Arrow buffer detachment
      await provider.close();
      provider = await LanceDBRAGProvider.create({ dbPath });

      // Query with empty resourceId array (should match nothing via "1 = 0" clause)
      const result = await provider.query({
        text: 'content',
        filters: { resourceId: [] },
      });

      expect(result.chunks).toHaveLength(0);
    }
  );

  // @ts-expect-error - Bun global is available at runtime
  it.skipIf(typeof Bun !== 'undefined')('should delete specific resource', async () => {
    provider = await LanceDBRAGProvider.create({ dbPath });

    const resource = await createTestResource(testFilePath, 'resource-to-delete');
    await provider.indexResources([resource]);

    // Close and reopen to avoid Bun + Arrow buffer detachment after indexing
    await provider.close();
    provider = await LanceDBRAGProvider.create({ dbPath });

    // Verify resource exists
    let stats = await provider.getStats();
    expect(stats.totalChunks).toBeGreaterThan(0);

    // Delete the resource
    await provider.deleteResource('resource-to-delete');

    // Close and reopen again after deletion
    await provider.close();
    provider = await LanceDBRAGProvider.create({ dbPath });

    // Verify empty after deletion
    stats = await provider.getStats();
    expect(stats.totalChunks).toBe(0);
  });

  it('should skip indexing unchanged resources', async () => {
    provider = await LanceDBRAGProvider.create({ dbPath });

    const resource = await createTestResource(testFilePath);

    // Index first time
    const result1 = await provider.indexResources([resource]);
    expect(result1.resourcesIndexed).toBe(1);
    expect(result1.resourcesSkipped).toBe(0);

    // Index again (should skip)
    const result2 = await provider.indexResources([resource]);
    expect(result2.resourcesIndexed).toBe(0);
    expect(result2.resourcesSkipped).toBe(1);
  });

  it('should update changed resources', async () => {
    provider = await LanceDBRAGProvider.create({ dbPath });

    const resource = await createTestResource(testFilePath);

    // Index first time
    await provider.indexResources([resource]);

    // Modify file content
    const modifiedPath = await createTestMarkdownFile(
      tempDir,
      'test-modified.md',
      '# Modified Document\n\nThis is completely different content.'
    );
    const modifiedResource = await createTestResource(modifiedPath, resource.id);

    // Index again (should update)
    const result = await provider.indexResources([modifiedResource]);
    expect(result.resourcesUpdated).toBe(1);
    expect(result.chunksDeleted).toBeGreaterThan(0);
    expect(result.chunksCreated).toBeGreaterThan(0);
  });

  it('should handle indexing errors gracefully', async () => {
    provider = await LanceDBRAGProvider.create({ dbPath });

    // Create resource with non-existent file (missing required fields will cause error)
    const badResource = {
      id: 'bad-resource',
      filePath: join(tempDir, 'nonexistent.md'),
      links: [],
      headings: [],
      sizeBytes: 0,
      estimatedTokenCount: 0,
      modifiedAt: new Date(),
      checksum: '0000000000000000000000000000000000000000000000000000000000000000',
    };

    const result = await provider.indexResources([badResource]);
    expect(result.errors?.length).toBeGreaterThan(0);
    expect(result.errors?.[0]?.resourceId).toBe('bad-resource');
  });

  it('should get stats for empty database', async () => {
    provider = await LanceDBRAGProvider.create({ dbPath });

    const stats = await provider.getStats();
    expect(stats.totalChunks).toBe(0);
    expect(stats.totalResources).toBe(0);
    expect(stats.embeddingModel).toBeTruthy();
  });

  it('should throw error for updateResource', async () => {
    provider = await LanceDBRAGProvider.create({ dbPath });

    await expect(provider.updateResource('test-id')).rejects.toThrow('Not implemented');
  });

  describe('Custom Metadata Filtering', () => {
    const TEST_MARKDOWN_CONTENT = '# Test\n\nContent here.';

    /**
     * Helper to create and index test chunks with custom metadata
     */
    async function indexTestChunksWithMetadata<TMetadata extends Record<string, unknown>>(
      provider: LanceDBRAGProvider<TMetadata>,
      tempDir: string,
      schema: { shape: Record<string, unknown> },
      metadataValues: TMetadata
    ): Promise<void> {
      const doc = await createTestMarkdownFile(tempDir, 'doc.md', TEST_MARKDOWN_CONTENT);

      const { chunkToLanceRow } = await import('../../src/schema.js');
      const { enrichChunks, chunkResource, generateContentHash } = await import('@vibe-agent-toolkit/rag');
      const { ApproximateTokenCounter } = await import('@vibe-agent-toolkit/rag');

      const resource = await createTestResource(doc, 'test-doc');
      const parseResult = await import('@vibe-agent-toolkit/resources').then((m) =>
        m.parseMarkdown(doc)
      );
      const chunks = chunkResource(
        { ...resource, content: parseResult.content, frontmatter: {} },
        { targetChunkSize: 512, modelTokenLimit: 8191, paddingFactor: 0.9, tokenCounter: new ApproximateTokenCounter() }
      );
      const embeddings = await provider['config'].embeddingProvider.embedBatch(
        chunks.chunks.map((c) => c.content)
      );
      const ragChunks = enrichChunks(
        chunks.chunks,
        { ...resource, content: parseResult.content, frontmatter: {} },
        embeddings,
        provider['config'].embeddingProvider.model
      );

      const rows = ragChunks.map((chunk) => {
        type ChunkWithCustomMetadata = typeof chunk & TMetadata;
        return chunkToLanceRow<TMetadata>(
          { ...chunk, ...metadataValues } as ChunkWithCustomMetadata,
          generateContentHash(parseResult.content),
          schema
        );
      });

      if (!provider['table'] && provider['connection']) {
        provider['table'] = await provider['connection'].createTable('rag_chunks', rows);
      }
    }

    it('should filter by string metadata field', async () => {
      const { z } = await import('zod');

      // Define custom metadata schema
      type CustomMetadata = { domain: string; priority: number };
      const CustomSchema = z.object({
        domain: z.string(),
        priority: z.number(),
      });

      // Create provider with custom metadata schema (use local variable for custom type)
      const customProvider = await LanceDBRAGProvider.create<CustomMetadata>({
        dbPath,
        metadataSchema: CustomSchema,
      });

      // Create test resources with custom metadata
      const securityDoc = await createTestMarkdownFile(
        tempDir,
        'security.md',
        '# Security Document\n\nThis is about security.'
      );
      const apiDoc = await createTestMarkdownFile(
        tempDir,
        'api.md',
        '# API Document\n\nThis is about the API.'
      );

      // Import chunkToLanceRow to create records with custom metadata
      const { chunkToLanceRow } = await import('../../src/schema.js');
      const { enrichChunks, chunkResource, generateContentHash } = await import('@vibe-agent-toolkit/rag');
      const { ApproximateTokenCounter } = await import('@vibe-agent-toolkit/rag');

      // Index security document
      const securityResource = await createTestResource(securityDoc, 'security-doc');
      const securityParseResult = await import('@vibe-agent-toolkit/resources').then((m) =>
        m.parseMarkdown(securityDoc)
      );
      const securityChunks = chunkResource(
        { ...securityResource, content: securityParseResult.content, frontmatter: {} },
        { targetChunkSize: 512, modelTokenLimit: 8191, tokenCounter: new ApproximateTokenCounter() }
      );
      const securityEmbeddings = await customProvider['config'].embeddingProvider.embedBatch(
        securityChunks.chunks.map((c) => c.content)
      );
      const securityRAGChunks = enrichChunks(
        securityChunks.chunks,
        { ...securityResource, content: securityParseResult.content, frontmatter: {} },
        securityEmbeddings,
        customProvider['config'].embeddingProvider.model
      );

      // Add custom metadata to security chunks
      const securityRows = securityRAGChunks.map((chunk) => {
        type ChunkWithCustomMetadata = typeof chunk & CustomMetadata;
        const row = chunkToLanceRow<CustomMetadata>(
          { ...chunk, domain: 'security', priority: 1 } as ChunkWithCustomMetadata,
          generateContentHash(securityParseResult.content),
          CustomSchema
        );
        return row;
      });

      // Index API document
      const apiResource = await createTestResource(apiDoc, 'api-doc');
      const apiParseResult = await import('@vibe-agent-toolkit/resources').then((m) =>
        m.parseMarkdown(apiDoc)
      );
      const apiChunks = chunkResource(
        { ...apiResource, content: apiParseResult.content, frontmatter: {} },
        { targetChunkSize: 512, modelTokenLimit: 8191, tokenCounter: new ApproximateTokenCounter() }
      );
      const apiEmbeddings = await customProvider['config'].embeddingProvider.embedBatch(
        apiChunks.chunks.map((c) => c.content)
      );
      const apiRAGChunks = enrichChunks(
        apiChunks.chunks,
        { ...apiResource, content: apiParseResult.content, frontmatter: {} },
        apiEmbeddings,
        customProvider['config'].embeddingProvider.model
      );

      // Add custom metadata to API chunks
      const apiRows = apiRAGChunks.map((chunk) => {
        type ChunkWithCustomMetadata = typeof chunk & CustomMetadata;
        const row = chunkToLanceRow<CustomMetadata>(
          { ...chunk, domain: 'api', priority: 2 } as ChunkWithCustomMetadata,
          generateContentHash(apiParseResult.content),
          CustomSchema
        );
        return row;
      });

      // Insert both into database
      if (!customProvider['table'] && customProvider['connection']) {
        customProvider['table'] = await customProvider['connection'].createTable('rag_chunks', [
          ...securityRows,
          ...apiRows,
        ]);
      } else if (customProvider['table']) {
        await customProvider['table'].add([...securityRows, ...apiRows]);
      }

      // Query with domain filter
      const result = await customProvider.query({
        text: 'document',
        filters: { metadata: { domain: 'security' } },
      });

      // All results should be from security domain
      expect(result.chunks.length).toBeGreaterThan(0);
      expect(
        result.chunks.every((chunk) => (chunk as typeof chunk & CustomMetadata).domain === 'security')
      ).toBe(true);

      // Clean up
      await customProvider.close();
    });

    it('should filter by number metadata field', async () => {
      const { z } = await import('zod');

      type CustomMetadata = { priority: number };
      const CustomSchema = z.object({ priority: z.number() });

      const customProvider = await LanceDBRAGProvider.create<CustomMetadata>({
        dbPath,
        metadataSchema: CustomSchema,
      });

      await indexTestChunksWithMetadata(customProvider, tempDir, CustomSchema, { priority: 1 });

      // Query with priority filter
      const result = await customProvider.query({
        text: 'content',
        filters: { metadata: { priority: 1 } },
      });

      expect(result.chunks.length).toBeGreaterThan(0);
      expect(
        result.chunks.every((chunk) => (chunk as typeof chunk & CustomMetadata).priority === 1)
      ).toBe(true);

      // Clean up
      await customProvider.close();
    });

    it('should filter by boolean metadata field', async () => {
      const { z } = await import('zod');

      type CustomMetadata = { active: boolean };
      const CustomSchema = z.object({ active: z.boolean() });

      const customProvider = await LanceDBRAGProvider.create<CustomMetadata>({
        dbPath,
        metadataSchema: CustomSchema,
      });

      await indexTestChunksWithMetadata(customProvider, tempDir, CustomSchema, { active: true });

      // Query with active filter
      const result = await customProvider.query({
        text: 'content',
        filters: { metadata: { active: true } },
      });

      expect(result.chunks.length).toBeGreaterThan(0);
      expect(
        result.chunks.every((chunk) => (chunk as typeof chunk & CustomMetadata).active === true)
      ).toBe(true);

      // Clean up
      await customProvider.close();
    });

    it('should filter by array metadata field with LIKE query', async () => {
      const { z } = await import('zod');

      type CustomMetadata = { tags: string[] };
      const CustomSchema = z.object({ tags: z.array(z.string()) });

      const customProvider = await LanceDBRAGProvider.create<CustomMetadata>({
        dbPath,
        metadataSchema: CustomSchema,
      });

      await indexTestChunksWithMetadata(customProvider, tempDir, CustomSchema, {
        tags: ['auth', 'security', 'api'],
      });

      // Query with tags filter (should match substring)
      const result = await customProvider.query({
        text: 'content',
        filters: { metadata: { tags: 'auth' } },
      });

      expect(result.chunks.length).toBeGreaterThan(0);
      // Tags are stored as CSV, so we can't directly check array membership
      // but we verified the LIKE query works in unit tests

      // Clean up
      await customProvider.close();
    });

    it('should combine multiple metadata filters', async () => {
      const { z } = await import('zod');

      type CustomMetadata = { domain: string; priority: number };
      const CustomSchema = z.object({
        domain: z.string(),
        priority: z.number(),
      });

      const customProvider = await LanceDBRAGProvider.create<CustomMetadata>({
        dbPath,
        metadataSchema: CustomSchema,
      });

      await indexTestChunksWithMetadata(customProvider, tempDir, CustomSchema, {
        domain: 'security',
        priority: 1,
      });

      // Query with multiple filters
      const result = await customProvider.query({
        text: 'content',
        filters: { metadata: { domain: 'security', priority: 1 } },
      });

      expect(result.chunks.length).toBeGreaterThan(0);
      expect(
        result.chunks.every((chunk) => (chunk as typeof chunk & CustomMetadata).domain === 'security')
      ).toBe(true);
      expect(
        result.chunks.every((chunk) => (chunk as typeof chunk & CustomMetadata).priority === 1)
      ).toBe(true);

      // Clean up
      await customProvider.close();
    });
  });

  describe('SQL Injection Prevention', () => {
    it('should safely handle resourceId with SQL injection attempt', async () => {
      provider = await LanceDBRAGProvider.create({ dbPath });

      // Create resource with malicious ID containing SQL injection
      const maliciousId = "doc' OR '1'='1' --";
      const normalId = 'safe-doc-id';

      const maliciousResource = await createTestResource(testFilePath, maliciousId);
      const normalResource = await createTestResource(testFilePath, normalId);

      // Index both resources
      await provider.indexResources([maliciousResource, normalResource]);

      // Query should only return chunks for the malicious ID, not all chunks
      const result = await provider.query({
        text: 'content',
        filters: { resourceId: maliciousId },
      });

      // Should only get chunks from malicious resource (single quotes properly escaped)
      expect(result.chunks.every(chunk => chunk.resourceId === maliciousId)).toBe(true);
      expect(result.chunks.some(chunk => chunk.resourceId === normalId)).toBe(false);

      // Delete should only delete the malicious resource, not all resources
      await provider.deleteResource(maliciousId);

      // Normal resource should still exist
      const afterDelete = await provider.query({
        text: 'content',
        filters: { resourceId: normalId },
      });
      expect(afterDelete.chunks.length).toBeGreaterThan(0);

      // Malicious resource should be deleted
      const maliciousDeleted = await provider.query({
        text: 'content',
        filters: { resourceId: maliciousId },
      });
      expect(maliciousDeleted.chunks.length).toBe(0);
    });

    it('should handle resource IDs with multiple single quotes', async () => {
      provider = await LanceDBRAGProvider.create({ dbPath });

      const complexId = "it's a 'test' doc";
      const resource = await createTestResource(testFilePath, complexId);

      // Should successfully index without SQL errors
      const indexResult = await provider.indexResources([resource]);
      expect(indexResult.resourcesIndexed).toBe(1);

      // Should successfully query
      const queryResult = await provider.query({
        text: 'content',
        filters: { resourceId: complexId },
      });
      expect(queryResult.chunks.length).toBeGreaterThan(0);
      expect(queryResult.chunks.every(chunk => chunk.resourceId === complexId)).toBe(true);

      // Should successfully delete
      await provider.deleteResource(complexId);
      const afterDelete = await provider.query({
        text: 'content',
        filters: { resourceId: complexId },
      });
      expect(afterDelete.chunks.length).toBe(0);
    });
  });
});
