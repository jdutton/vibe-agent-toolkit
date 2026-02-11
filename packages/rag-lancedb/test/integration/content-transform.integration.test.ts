/**
 * Integration tests for contentTransform in LanceDB RAG provider.
 *
 * Verifies that the contentTransform option correctly transforms content
 * before chunking and storage, that the content hash is computed on the
 * transformed output, and that indexing without contentTransform preserves
 * the original behavior.
 */

import { join } from 'node:path';

import type { ContentTransformOptions } from '@vibe-agent-toolkit/resources';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LanceDBRAGProvider } from '../../src/lancedb-rag-provider.js';
import { createTestMarkdownFile, createTestResource, setupLanceDBTestSuite } from '../test-helpers.js';

describe('LanceDB Content Transform Integration', () => {
  const suite = setupLanceDBTestSuite();
  beforeEach(suite.beforeEach);
  afterEach(suite.afterEach);

  /**
   * Helper to create a markdown file with links and a matching resource.
   * Returns the resource with populated links array.
   */
  async function createResourceWithLinks(
    filename: string,
    content: string,
    resourceId = 'test-1',
  ) {
    const filePath = await createTestMarkdownFile(suite.tempDir, filename, content);
    const resource = await createTestResource(filePath, resourceId);
    return resource;
  }

  it('should rewrite links in stored chunks when contentTransform is configured', async () => {
    const contentTransform: ContentTransformOptions = {
      linkRewriteRules: [
        {
          match: { type: 'local_file' },
          template: '{{link.text}} (see: {{link.href}})',
        },
      ],
    };

    suite.provider = await LanceDBRAGProvider.create({ dbPath: suite.dbPath, contentTransform });

    // Create a markdown file with a local link
    const resource = await createResourceWithLinks(
      'doc-with-links.md',
      `# Guide

This document references [another file](./other.md) for details.

## Section 1

Content in section 1 that mentions [the other doc](./other.md) again.`,
    );

    // Ensure the resource has local_file links
    expect(resource.links.length).toBeGreaterThan(0);
    expect(resource.links.some((l) => l.type === 'local_file')).toBe(true);

    const result = await suite.provider.indexResources([resource]);
    expect(result.resourcesIndexed).toBe(1);
    expect(result.errors).toEqual([]);

    // Query and check that chunks contain rewritten links
    const queryResult = await suite.provider.query({ text: 'document references', limit: 10 });
    expect(queryResult.chunks.length).toBeGreaterThan(0);

    // At least one chunk should contain the rewritten link format
    const allContent = queryResult.chunks.map((c) => c.content).join('\n');
    expect(allContent).toContain('another file (see: ./other.md)');
    // Original markdown link syntax should NOT be present
    expect(allContent).not.toContain('[another file](./other.md)');
  });

  it('should compute contentHash on transformed content', async () => {
    // First, index WITHOUT transform
    const providerNoTransform = await LanceDBRAGProvider.create({
      dbPath: join(suite.tempDir, 'db-no-transform'),
    });

    const resource = await createResourceWithLinks(
      'hash-test.md',
      `# Hash Test

See [local link](./other.md) for info.`,
      'hash-doc',
    );

    const resultNoTransform = await providerNoTransform.indexResources([resource]);
    expect(resultNoTransform.resourcesIndexed).toBe(1);
    await providerNoTransform.close();

    // Now index WITH transform
    const contentTransform: ContentTransformOptions = {
      linkRewriteRules: [
        {
          match: { type: 'local_file' },
          template: 'LINK: {{link.text}}',
        },
      ],
    };

    const providerWithTransform = await LanceDBRAGProvider.create({
      dbPath: join(suite.tempDir, 'db-with-transform'),
      contentTransform,
    });

    const resultWithTransform = await providerWithTransform.indexResources([resource]);
    expect(resultWithTransform.resourcesIndexed).toBe(1);
    await providerWithTransform.close();

    // Re-indexing the same file with transform should NOT skip
    // because the content hash is different (transformed vs original)
    const providerReindex = await LanceDBRAGProvider.create({
      dbPath: join(suite.tempDir, 'db-no-transform'),
      contentTransform,
    });

    const reindexResult = await providerReindex.indexResources([resource]);
    // Should detect content change since the hash is now computed on transformed content
    expect(reindexResult.resourcesUpdated).toBe(1);
    expect(reindexResult.resourcesSkipped).toBe(0);
    await providerReindex.close();
  });

  it('should trigger re-index when contentTransform rules change', async () => {
    const resource = await createResourceWithLinks(
      'reindex-test.md',
      `# Re-index Test

Check [the guide](./guide.md) for details.`,
      'reindex-doc',
    );

    // Index with transform v1
    const transformV1: ContentTransformOptions = {
      linkRewriteRules: [
        {
          match: { type: 'local_file' },
          template: 'REF: {{link.text}}',
        },
      ],
    };

    suite.provider = await LanceDBRAGProvider.create({ dbPath: suite.dbPath, contentTransform: transformV1 });
    const result1 = await suite.provider.indexResources([resource]);
    expect(result1.resourcesIndexed).toBe(1);

    // Re-index with same transform (should skip)
    const result2 = await suite.provider.indexResources([resource]);
    expect(result2.resourcesSkipped).toBe(1);

    // Now change the transform template
    await suite.provider.close();
    const transformV2: ContentTransformOptions = {
      linkRewriteRules: [
        {
          match: { type: 'local_file' },
          template: 'SEE: {{link.text}} ({{link.href}})',
        },
      ],
    };

    suite.provider = await LanceDBRAGProvider.create({ dbPath: suite.dbPath, contentTransform: transformV2 });
    const result3 = await suite.provider.indexResources([resource]);
    // Different transform produces different content hash => update
    expect(result3.resourcesUpdated).toBe(1);
    expect(result3.resourcesSkipped).toBe(0);
  });

  it('should preserve original behavior when contentTransform is not configured', async () => {
    suite.provider = await LanceDBRAGProvider.create({ dbPath: suite.dbPath });

    // Create a markdown file with links
    const resource = await createResourceWithLinks(
      'no-transform.md',
      `# No Transform

This has a [local link](./other.md) that should be preserved.`,
    );

    const result = await suite.provider.indexResources([resource]);
    expect(result.resourcesIndexed).toBe(1);
    expect(result.errors).toEqual([]);

    // Query and verify original links are preserved
    const queryResult = await suite.provider.query({ text: 'local link', limit: 10 });
    expect(queryResult.chunks.length).toBeGreaterThan(0);

    const allContent = queryResult.chunks.map((c) => c.content).join('\n');
    // Original markdown link syntax should still be present
    expect(allContent).toContain('[local link](./other.md)');
  });

  it('should only rewrite matching links and leave others untouched', async () => {
    const contentTransform: ContentTransformOptions = {
      linkRewriteRules: [
        {
          match: { type: 'local_file' },
          template: 'LOCAL: {{link.text}}',
        },
        // No rule for external links - they should pass through unchanged
      ],
    };

    suite.provider = await LanceDBRAGProvider.create({ dbPath: suite.dbPath, contentTransform });

    const resource = await createResourceWithLinks(
      'mixed-links.md',
      `# Mixed Links

See [local doc](./local.md) and [external site](https://example.com) for details.`,
    );

    const result = await suite.provider.indexResources([resource]);
    expect(result.resourcesIndexed).toBe(1);

    const queryResult = await suite.provider.query({ text: 'mixed links', limit: 10 });
    const allContent = queryResult.chunks.map((c) => c.content).join('\n');

    // Local link should be rewritten
    expect(allContent).toContain('LOCAL: local doc');
    // External link should be preserved in original markdown format
    expect(allContent).toContain('[external site](https://example.com)');
  });

  it('should handle content with no links and contentTransform configured', async () => {
    const contentTransform: ContentTransformOptions = {
      linkRewriteRules: [
        {
          match: { type: 'local_file' },
          template: 'LINK: {{link.text}}',
        },
      ],
    };

    suite.provider = await LanceDBRAGProvider.create({ dbPath: suite.dbPath, contentTransform });

    // Create a markdown file with no links at all
    const filePath = await createTestMarkdownFile(
      suite.tempDir,
      'no-links.md',
      `# No Links

This document has no links at all. Just plain text content.`,
    );
    const resource = await createTestResource(filePath);

    const result = await suite.provider.indexResources([resource]);
    expect(result.resourcesIndexed).toBe(1);
    expect(result.errors).toEqual([]);

    // Content should be stored as-is since there are no links to rewrite
    const queryResult = await suite.provider.query({ text: 'no links', limit: 10 });
    expect(queryResult.chunks.length).toBeGreaterThan(0);
    const allContent = queryResult.chunks.map((c) => c.content).join('\n');
    expect(allContent).toContain('This document has no links at all');
  });

  it('should produce consistent content hash for same transform + content', async () => {
    const contentTransform: ContentTransformOptions = {
      linkRewriteRules: [
        {
          match: { type: 'local_file' },
          template: 'REF: {{link.text}}',
        },
      ],
    };

    suite.provider = await LanceDBRAGProvider.create({ dbPath: suite.dbPath, contentTransform });

    const resource = await createResourceWithLinks(
      'consistent-hash.md',
      `# Consistent

See [the doc](./doc.md) here.`,
      'consistent-doc',
    );

    // Index first time
    const result1 = await suite.provider.indexResources([resource]);
    expect(result1.resourcesIndexed).toBe(1);

    // Index same resource again (should skip because hash is the same)
    const result2 = await suite.provider.indexResources([resource]);
    expect(result2.resourcesSkipped).toBe(1);
    expect(result2.resourcesIndexed).toBe(0);
  });
});
