/**
 * Backward compatibility tests (simplified)
 *
 * Ensures existing code using default metadata continues to work.
 * These tests verify that the generic metadata system maintains backward
 * compatibility with existing code that doesn't use custom metadata schemas.
 */

import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LanceDBRAGProvider } from '../../src/lancedb-rag-provider.js';
import { createTempDir, createTestMarkdownFile, createTestResource } from '../test-helpers.js';

describe('Backward compatibility', () => {
  const TEST_SEARCH_TERM = 'documentation';
  const SECURITY_DOC_ID = 'security-doc';

  let tempDir: string;
  let dbPath: string;
  let provider: LanceDBRAGProvider;

  beforeEach(async () => {
    tempDir = await createTempDir();
    dbPath = join(tempDir, 'db');
  });

  afterEach(async () => {
    if (provider) {
      await provider.close();
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should work without metadataSchema parameter (defaults to DefaultRAGMetadata)', async () => {
    // Create provider WITHOUT metadataSchema - should default to DefaultRAGMetadata
    provider = await LanceDBRAGProvider.create({ dbPath });

    // Create a simple test markdown file
    const filePath = await createTestMarkdownFile(
      tempDir,
      'test.md',
      '# Test Document\n\nThis is a simple test.'
    );

    // Index the resource using default metadata
    const resource = await createTestResource(filePath, 'test-doc');
    const result = await provider.indexResources([resource]);

    // Verify indexing worked
    expect(result.errors).toEqual([]);
    expect(result.resourcesIndexed).toBe(1);
    expect(result.chunksCreated).toBeGreaterThan(0);
  });

  it('should support basic query and filtering with default metadata', async () => {
    provider = await LanceDBRAGProvider.create({ dbPath });

    // Create test files with default metadata fields
    const securityDoc = await createTestMarkdownFile(
      tempDir,
      'security.md',
      '# Security\n\nSecurity documentation content.'
    );
    const apiDoc = await createTestMarkdownFile(
      tempDir,
      'api.md',
      '# API\n\nAPI documentation content.'
    );

    // Index resources
    const securityResource = await createTestResource(securityDoc, SECURITY_DOC_ID);
    const apiResource = await createTestResource(apiDoc, 'api-doc');
    await provider.indexResources([securityResource, apiResource]);

    // Query without filters - should return results
    const allResults = await provider.query({ text: TEST_SEARCH_TERM, limit: 10 });
    expect(allResults.chunks.length).toBeGreaterThan(0);

    // Query with resourceId filter - should filter correctly
    const securityResults = await provider.query({
      text: TEST_SEARCH_TERM,
      filters: { resourceId: SECURITY_DOC_ID },
    });
    expect(securityResults.chunks.every((chunk) => chunk.resourceId === SECURITY_DOC_ID)).toBe(true);
  });

  it('should maintain RAGChunk type compatibility', async () => {
    provider = await LanceDBRAGProvider.create({ dbPath });

    // Create and index a resource
    const filePath = await createTestMarkdownFile(
      tempDir,
      'test.md',
      '# Test\n\nSome content for testing.'
    );
    const resource = await createTestResource(filePath, 'test-id');
    await provider.indexResources([resource]);

    // Query to get chunks
    const result = await provider.query({ text: 'content', limit: 5 });
    expect(result.chunks.length).toBeGreaterThan(0);

    // Verify chunk has all core fields (from CoreRAGChunk)
    const chunk = result.chunks[0];
    expect(chunk).toHaveProperty('chunkId');
    expect(chunk).toHaveProperty('resourceId');
    expect(chunk).toHaveProperty('content');
    expect(chunk).toHaveProperty('contentHash');
    expect(chunk).toHaveProperty('tokenCount');
    expect(chunk).toHaveProperty('embedding');
    expect(chunk).toHaveProperty('embeddingModel');
    expect(chunk).toHaveProperty('embeddedAt');

    // Verify chunk has default metadata fields (from DefaultRAGMetadata)
    expect(chunk).toHaveProperty('filePath');
    expect(typeof chunk.filePath).toBe('string');

    // Optional fields may or may not be present
    if ('tags' in chunk) {
      expect(Array.isArray(chunk.tags)).toBe(true);
    }
    if ('type' in chunk) {
      expect(typeof chunk.type).toBe('string');
    }
  });
});
