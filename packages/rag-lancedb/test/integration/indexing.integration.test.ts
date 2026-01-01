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
});
