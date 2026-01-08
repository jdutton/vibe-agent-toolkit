
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

    // Create resource with non-existent file
    const badResource = {
      id: 'bad-resource',
      title: 'Bad Resource',
      type: 'documentation' as const,
      filePath: join(tempDir, 'nonexistent.md'),
      relativePath: 'nonexistent.md',
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
});
