/**
 * Unit tests for LanceDB RAG Provider - Database Size Calculation
 */

import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LanceDBRAGProvider } from '../../src/lancedb-rag-provider.js';
import { createTempDir, createTestMarkdownFile, createTestResource } from '../test-helpers.js';

describe('LanceDBRAGProvider - Database Size Calculation', () => {
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

  it('should return zero database size for empty database', async () => {
    provider = await LanceDBRAGProvider.create({ dbPath });

    const stats = await provider.getStats();

    expect(stats.dbSizeBytes).toBe(0);
    expect(stats.totalChunks).toBe(0);
    expect(stats.totalResources).toBe(0);
  });

  it('should calculate non-zero database size after indexing', async () => {
    provider = await LanceDBRAGProvider.create({ dbPath });

    // Create test markdown file
    const testFilePath = await createTestMarkdownFile(
      tempDir,
      'test.md',
      '# Test Document\n\nThis is test content that will create database files.'
    );

    // Create and index test resource
    const resource = await createTestResource(testFilePath);
    await provider.indexResources([resource]);

    // Get stats
    const stats = await provider.getStats();

    // Database should now have non-zero size
    expect(stats.dbSizeBytes).toBeGreaterThan(0);
    expect(stats.totalChunks).toBeGreaterThan(0);
    expect(stats.totalResources).toBe(1);

    // Size should be reasonable (not absurdly large)
    expect(stats.dbSizeBytes).toBeLessThan(100 * 1024 * 1024); // Less than 100MB
  });

  it('should handle missing database directory gracefully', async () => {
    const nonExistentPath = join(tempDir, 'nonexistent', 'db');
    provider = await LanceDBRAGProvider.create({ dbPath: nonExistentPath });

    const stats = await provider.getStats();

    // Should return 0 for missing directory
    expect(stats.dbSizeBytes).toBe(0);
  });
});
