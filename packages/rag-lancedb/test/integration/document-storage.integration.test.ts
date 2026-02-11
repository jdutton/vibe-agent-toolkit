/**
 * Integration tests for rag_documents table (full document storage).
 *
 * Verifies that when `storeDocuments: true` is configured:
 * - Full document content is stored in a separate rag_documents table
 * - Documents can be retrieved by resourceId via getDocument()
 * - Content transforms are applied to stored documents
 * - Metadata from frontmatter is stored on document records
 * - Incremental updates work (changed content updates the document)
 * - Deleting a resource also removes the document record
 * - When storeDocuments is disabled (default), no documents table is created
 */

import type { ContentTransformOptions } from '@vibe-agent-toolkit/resources';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LanceDBRAGProvider } from '../../src/lancedb-rag-provider.js';
import { createTestMarkdownFile, createTestResource, setupLanceDBTestSuite } from '../test-helpers.js';

/** Shared config for provider creation with document storage enabled */
const STORE_DOCS_CONFIG = { storeDocuments: true } as const;

// Repeated resource IDs
const LOCAL_FILE_TYPE = 'local_file';
const DOC_1_ID = 'doc-1';
const UPDATE_DOC_ID = 'update-doc';
const DELETE_DOC_ID = 'delete-doc';

describe('LanceDB Document Storage Integration', () => {
  const suite = setupLanceDBTestSuite();
  beforeEach(suite.beforeEach);
  afterEach(suite.afterEach);

  /** Close the current provider and reopen with given options (defaults to STORE_DOCS_CONFIG) */
  async function reconnectProvider(options?: Record<string, unknown>) {
    if (suite.provider) await suite.provider.close();
    suite.provider = await LanceDBRAGProvider.create({
      dbPath: suite.dbPath,
      ...STORE_DOCS_CONFIG,
      ...options,
    });
  }

  it('should store and retrieve a document by resourceId', async () => {
    suite.provider = await LanceDBRAGProvider.create({ dbPath: suite.dbPath, ...STORE_DOCS_CONFIG });

    const filePath = await createTestMarkdownFile(
      suite.tempDir,
      'doc.md',
      `# Test Document

This is a test document for document storage.

## Section 1

Content in section 1 about testing.`
    );

    const resource = await createTestResource(filePath, DOC_1_ID);
    const result = await suite.provider.indexResources([resource]);
    expect(result.resourcesIndexed).toBe(1);
    expect(result.errors).toEqual([]);

    // Reconnect to ensure fresh connection for getDocument
    await reconnectProvider();

    const doc = await suite.provider.getDocument(DOC_1_ID);
    expect(doc).not.toBeNull();
    expect(doc?.resourceId).toBe(DOC_1_ID);
    expect(doc?.filePath).toBe(filePath);
    expect(doc?.content).toContain('Test Document');
    expect(doc?.content).toContain('Content in section 1');
    expect(doc?.contentHash).toBeTruthy();
    expect(doc?.tokenCount).toBeGreaterThan(0);
    expect(doc?.totalChunks).toBeGreaterThan(0);
    expect(doc?.indexedAt).toBeInstanceOf(Date);
    expect(doc?.indexedAt.getTime()).toBeGreaterThan(0);
  });

  it('should store transformed content when contentTransform is configured', async () => {
    const contentTransform: ContentTransformOptions = {
      linkRewriteRules: [
        {
          match: { type: LOCAL_FILE_TYPE },
          template: '{{link.text}} (see: {{link.href}})',
        },
      ],
    };

    suite.provider = await LanceDBRAGProvider.create({
      dbPath: suite.dbPath,
      ...STORE_DOCS_CONFIG,
      contentTransform,
    });

    const filePath = await createTestMarkdownFile(
      suite.tempDir,
      'transformed.md',
      `# Guide

This references [another file](./other.md) for details.`
    );

    const resource = await createTestResource(filePath, 'transformed-doc');

    // Verify links were parsed
    expect(resource.links.some((l) => l.type === LOCAL_FILE_TYPE)).toBe(true);

    const result = await suite.provider.indexResources([resource]);
    expect(result.resourcesIndexed).toBe(1);

    await reconnectProvider({ contentTransform });

    const doc = await suite.provider.getDocument('transformed-doc');
    expect(doc).not.toBeNull();
    // Content should contain rewritten link format
    expect(doc?.content).toContain('another file (see: ./other.md)');
    // Original markdown link syntax should NOT be present
    expect(doc?.content).not.toContain('[another file](./other.md)');
  });

  it('should store metadata from frontmatter on document records', async () => {
    suite.provider = await LanceDBRAGProvider.create({ dbPath: suite.dbPath, ...STORE_DOCS_CONFIG });

    const filePath = await createTestMarkdownFile(
      suite.tempDir,
      'with-meta.md',
      `---
tags: [security, auth]
type: guide
title: Security Guide
---

# Security Guide

Important security information about authentication.`
    );

    const resource = await createTestResource(filePath, 'meta-doc');
    expect(resource.frontmatter).toBeDefined();

    const result = await suite.provider.indexResources([resource]);
    expect(result.resourcesIndexed).toBe(1);

    await reconnectProvider();

    const doc = await suite.provider.getDocument('meta-doc');
    expect(doc).not.toBeNull();
    expect(doc?.metadata).toBeDefined();
    // Default metadata schema fields should be present
    expect(doc?.metadata['title']).toBe('Security Guide');
    expect(doc?.metadata['type']).toBe('guide');
  });

  it('should return null when storeDocuments is not enabled', async () => {
    // Default: storeDocuments = false
    suite.provider = await LanceDBRAGProvider.create({ dbPath: suite.dbPath });

    const filePath = await createTestMarkdownFile(
      suite.tempDir,
      'no-store.md',
      '# No Storage\n\nThis document will not be stored.'
    );

    const resource = await createTestResource(filePath, 'no-store-doc');
    await suite.provider.indexResources([resource]);

    // getDocument should return null because rag_documents table doesn't exist
    const doc = await suite.provider.getDocument('no-store-doc');
    expect(doc).toBeNull();
  });

  it('should return null for nonexistent resourceId', async () => {
    suite.provider = await LanceDBRAGProvider.create({ dbPath: suite.dbPath, ...STORE_DOCS_CONFIG });

    const filePath = await createTestMarkdownFile(
      suite.tempDir,
      'exists.md',
      '# Exists\n\nThis document exists.'
    );

    const resource = await createTestResource(filePath, 'existing-doc');
    await suite.provider.indexResources([resource]);

    await reconnectProvider();

    const doc = await suite.provider.getDocument('nonexistent-doc');
    expect(doc).toBeNull();
  });

  it('should update document when resource content changes', async () => {
    suite.provider = await LanceDBRAGProvider.create({ dbPath: suite.dbPath, ...STORE_DOCS_CONFIG });

    // Index original content
    const originalPath = await createTestMarkdownFile(
      suite.tempDir,
      'original.md',
      '# Original\n\nOriginal content here.'
    );
    const resource = await createTestResource(originalPath, UPDATE_DOC_ID);
    await suite.provider.indexResources([resource]);

    // Modify content and re-index with same resourceId
    const modifiedPath = await createTestMarkdownFile(
      suite.tempDir,
      'modified.md',
      '# Modified\n\nCompletely different content after modification.'
    );
    const modifiedResource = await createTestResource(modifiedPath, UPDATE_DOC_ID);
    const updateResult = await suite.provider.indexResources([modifiedResource]);
    expect(updateResult.resourcesUpdated).toBe(1);

    await reconnectProvider();

    const doc = await suite.provider.getDocument(UPDATE_DOC_ID);
    expect(doc).not.toBeNull();
    expect(doc?.content).toContain('Completely different content');
    expect(doc?.content).not.toContain('Original content');
    expect(doc?.filePath).toBe(modifiedPath);
  });

  // @ts-expect-error - Bun global is available at runtime
  it.skipIf(typeof Bun !== 'undefined')(
    'should remove document when resource is deleted',
    async () => {
      suite.provider = await LanceDBRAGProvider.create({ dbPath: suite.dbPath, ...STORE_DOCS_CONFIG });

      const filePath = await createTestMarkdownFile(
        suite.tempDir,
        'deleteme.md',
        '# Delete Me\n\nThis document will be deleted.'
      );
      const resource = await createTestResource(filePath, DELETE_DOC_ID);
      await suite.provider.indexResources([resource]);

      // Close and reopen to avoid Arrow buffer issues
      await reconnectProvider();

      // Verify document exists
      let doc = await suite.provider.getDocument(DELETE_DOC_ID);
      expect(doc).not.toBeNull();

      // Delete the resource
      await suite.provider.deleteResource(DELETE_DOC_ID);

      // Close and reopen again after deletion
      await reconnectProvider();

      // Document should be gone
      doc = await suite.provider.getDocument(DELETE_DOC_ID);
      expect(doc).toBeNull();
    }
  );

  it('should default storeDocuments to false (no documents table created)', async () => {
    suite.provider = await LanceDBRAGProvider.create({ dbPath: suite.dbPath });

    const filePath = await createTestMarkdownFile(
      suite.tempDir,
      'default.md',
      '# Default\n\nDefault configuration test.'
    );
    const resource = await createTestResource(filePath, 'default-doc');
    await suite.provider.indexResources([resource]);

    // Chunks should be indexed
    const stats = await suite.provider.getStats();
    expect(stats.totalChunks).toBeGreaterThan(0);

    // But getDocument returns null (no documents table)
    const doc = await suite.provider.getDocument('default-doc');
    expect(doc).toBeNull();
  });

  it('should store multiple documents and retrieve each independently', async () => {
    suite.provider = await LanceDBRAGProvider.create({ dbPath: suite.dbPath, ...STORE_DOCS_CONFIG });

    const file1 = await createTestMarkdownFile(
      suite.tempDir,
      'doc1.md',
      '# Document One\n\nFirst document content.'
    );
    const file2 = await createTestMarkdownFile(
      suite.tempDir,
      'doc2.md',
      '# Document Two\n\nSecond document content.'
    );

    const resource1 = await createTestResource(file1, 'multi-1');
    const resource2 = await createTestResource(file2, 'multi-2');

    const result = await suite.provider.indexResources([resource1, resource2]);
    expect(result.resourcesIndexed).toBe(2);

    await reconnectProvider();

    const doc1 = await suite.provider.getDocument('multi-1');
    expect(doc1).not.toBeNull();
    expect(doc1?.content).toContain('First document content');

    const doc2 = await suite.provider.getDocument('multi-2');
    expect(doc2).not.toBeNull();
    expect(doc2?.content).toContain('Second document content');
  });

  it('should preserve existing documents when indexing new resources', async () => {
    suite.provider = await LanceDBRAGProvider.create({ dbPath: suite.dbPath, ...STORE_DOCS_CONFIG });

    // Index first batch
    const file1 = await createTestMarkdownFile(
      suite.tempDir,
      'batch1.md',
      '# Batch One\n\nFirst batch content.'
    );
    const resource1 = await createTestResource(file1, 'batch-1');
    await suite.provider.indexResources([resource1]);

    // Index second batch (different resource)
    const file2 = await createTestMarkdownFile(
      suite.tempDir,
      'batch2.md',
      '# Batch Two\n\nSecond batch content.'
    );
    const resource2 = await createTestResource(file2, 'batch-2');
    await suite.provider.indexResources([resource2]);

    await reconnectProvider();

    // Both documents should exist
    const doc1 = await suite.provider.getDocument('batch-1');
    expect(doc1).not.toBeNull();
    expect(doc1?.content).toContain('First batch content');

    const doc2 = await suite.provider.getDocument('batch-2');
    expect(doc2).not.toBeNull();
    expect(doc2?.content).toContain('Second batch content');
  });

  it('should track totalChunks accurately on document record', async () => {
    suite.provider = await LanceDBRAGProvider.create({ dbPath: suite.dbPath, ...STORE_DOCS_CONFIG });

    const filePath = await createTestMarkdownFile(
      suite.tempDir,
      'chunks.md',
      '# Chunk Test\n\nContent here.'
    );
    const resource = await createTestResource(filePath, 'chunk-doc');
    const result = await suite.provider.indexResources([resource]);

    await reconnectProvider();

    const doc = await suite.provider.getDocument('chunk-doc');
    expect(doc).not.toBeNull();
    expect(doc?.totalChunks).toBe(result.chunksCreated);
  });
});
