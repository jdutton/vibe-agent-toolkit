/**
 * Unit tests for LanceDB RAG Provider - Database Size Calculation
 */

import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LanceDBRAGProvider } from '../../src/lancedb-rag-provider.js';
import { createTestMarkdownFile, createTestResource, setupLanceDBTestSuite } from '../test-helpers.js';

describe('LanceDBRAGProvider - Database Size Calculation', () => {
  const suite = setupLanceDBTestSuite();
  beforeEach(suite.beforeEach);
  afterEach(suite.afterEach);

  it('should return zero database size for empty database', async () => {
    suite.provider = await LanceDBRAGProvider.create({ dbPath: suite.dbPath });

    const stats = await suite.provider.getStats();

    expect(stats.dbSizeBytes).toBe(0);
    expect(stats.totalChunks).toBe(0);
    expect(stats.totalResources).toBe(0);
  });

  it('should calculate non-zero database size after indexing', async () => {
    suite.provider = await LanceDBRAGProvider.create({ dbPath: suite.dbPath });

    // Create test markdown file
    const testFilePath = await createTestMarkdownFile(
      suite.tempDir,
      'test.md',
      '# Test Document\n\nThis is test content that will create database files.'
    );

    // Create and index test resource
    const resource = await createTestResource(testFilePath);
    await suite.provider.indexResources([resource]);

    // Get stats
    const stats = await suite.provider.getStats();

    // Database should now have non-zero size
    expect(stats.dbSizeBytes).toBeGreaterThan(0);
    expect(stats.totalChunks).toBeGreaterThan(0);
    expect(stats.totalResources).toBe(1);

    // Size should be reasonable (not absurdly large)
    expect(stats.dbSizeBytes).toBeLessThan(100 * 1024 * 1024); // Less than 100MB
  });

  it('should handle missing database directory gracefully', async () => {
    const nonExistentPath = join(suite.tempDir, 'nonexistent', 'db');
    suite.provider = await LanceDBRAGProvider.create({ dbPath: nonExistentPath });

    const stats = await suite.provider.getStats();

    // Should return 0 for missing directory
    expect(stats.dbSizeBytes).toBe(0);
  });
});
