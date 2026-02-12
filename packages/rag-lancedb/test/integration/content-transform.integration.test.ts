/**
 * Integration tests for contentTransform in LanceDB RAG provider.
 *
 * Verifies that the contentTransform option correctly transforms content
 * before chunking and storage, that the content hash is computed on the
 * transformed output, and that indexing without contentTransform preserves
 * the original behavior.
 */

import { join } from 'node:path';

import type { ResourceMetadata } from '@vibe-agent-toolkit/resources';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LanceDBRAGProvider } from '../../src/lancedb-rag-provider.js';
import {
  createLinkRewriteTransform,
  createResourceWithLinks,
  createTestMarkdownFile,
  createTestResource,
  queryAllContent,
  setupLanceDBTestSuite,
} from '../test-helpers.js';

describe('LanceDB Content Transform Integration', () => {
  const suite = setupLanceDBTestSuite();
  beforeEach(suite.beforeEach);
  afterEach(suite.afterEach);

  /** Index resources, assert success (indexed count + no errors), and query all content. */
  async function indexAndQuery(resources: ResourceMetadata[], queryText: string): Promise<string> {
    const provider = suite.provider;
    if (!provider) throw new Error('Provider not initialized');
    const result = await provider.indexResources(resources);
    expect(result.resourcesIndexed).toBe(resources.length);
    expect(result.errors).toEqual([]);
    return queryAllContent(provider, queryText);
  }

  it('should rewrite links in stored chunks when contentTransform is configured', async () => {
    const contentTransform = createLinkRewriteTransform('{{link.text}} (see: {{link.href}})');

    suite.provider = await LanceDBRAGProvider.create({ dbPath: suite.dbPath, contentTransform });

    const resource = await createResourceWithLinks(
      suite.tempDir,
      'doc-with-links.md',
      `# Guide

This document references [another file](./other.md) for details.

## Section 1

Content in section 1 that mentions [the other doc](./other.md) again.`,
    );

    expect(resource.links.length).toBeGreaterThan(0);
    expect(resource.links.some((l) => l.type === 'local_file')).toBe(true);

    const allContent = await indexAndQuery([resource], 'document references');
    expect(allContent).toContain('another file (see: ./other.md)');
    expect(allContent).not.toContain('[another file](./other.md)');
  });

  it('should compute contentHash on transformed content', async () => {
    // Index WITHOUT transform
    const providerNoTransform = await LanceDBRAGProvider.create({
      dbPath: join(suite.tempDir, 'db-no-transform'),
    });

    const resource = await createResourceWithLinks(
      suite.tempDir,
      'hash-test.md',
      `# Hash Test

See [local link](./other.md) for info.`,
      'hash-doc',
    );

    const resultNoTransform = await providerNoTransform.indexResources([resource]);
    expect(resultNoTransform.resourcesIndexed).toBe(1);
    await providerNoTransform.close();

    // Index WITH transform
    const contentTransform = createLinkRewriteTransform('LINK: {{link.text}}');

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
    expect(reindexResult.resourcesUpdated).toBe(1);
    expect(reindexResult.resourcesSkipped).toBe(0);
    await providerReindex.close();
  });

  it('should trigger re-index when contentTransform rules change', async () => {
    const resource = await createResourceWithLinks(
      suite.tempDir,
      'reindex-test.md',
      `# Re-index Test

Check [the guide](./guide.md) for details.`,
      'reindex-doc',
    );

    // Index with transform v1
    const transformV1 = createLinkRewriteTransform('REF: {{link.text}}');
    suite.provider = await LanceDBRAGProvider.create({ dbPath: suite.dbPath, contentTransform: transformV1 });
    const result1 = await suite.provider.indexResources([resource]);
    expect(result1.resourcesIndexed).toBe(1);

    // Re-index with same transform (should skip)
    const result2 = await suite.provider.indexResources([resource]);
    expect(result2.resourcesSkipped).toBe(1);

    // Now change the transform template
    await suite.provider.close();
    const transformV2 = createLinkRewriteTransform('SEE: {{link.text}} ({{link.href}})');
    suite.provider = await LanceDBRAGProvider.create({ dbPath: suite.dbPath, contentTransform: transformV2 });
    const result3 = await suite.provider.indexResources([resource]);
    // Different transform produces different content hash => update
    expect(result3.resourcesUpdated).toBe(1);
    expect(result3.resourcesSkipped).toBe(0);
  });

  it('should preserve original behavior when contentTransform is not configured', async () => {
    suite.provider = await LanceDBRAGProvider.create({ dbPath: suite.dbPath });

    const resource = await createResourceWithLinks(
      suite.tempDir,
      'no-transform.md',
      `# No Transform

This has a [local link](./other.md) that should be preserved.`,
    );

    const allContent = await indexAndQuery([resource], 'local link');
    expect(allContent).toContain('[local link](./other.md)');
  });

  it('should only rewrite matching links and leave others untouched', async () => {
    const contentTransform = createLinkRewriteTransform('LOCAL: {{link.text}}');
    suite.provider = await LanceDBRAGProvider.create({ dbPath: suite.dbPath, contentTransform });

    const resource = await createResourceWithLinks(
      suite.tempDir,
      'mixed-links.md',
      `# Mixed Links

See [local doc](./local.md) and [external site](https://example.com) for details.`,
    );

    const result = await suite.provider.indexResources([resource]);
    expect(result.resourcesIndexed).toBe(1);

    const allContent = await queryAllContent(suite.provider, 'mixed links');
    expect(allContent).toContain('LOCAL: local doc');
    expect(allContent).toContain('[external site](https://example.com)');
  });

  it('should handle content with no links and contentTransform configured', async () => {
    const contentTransform = createLinkRewriteTransform('LINK: {{link.text}}');
    suite.provider = await LanceDBRAGProvider.create({ dbPath: suite.dbPath, contentTransform });

    const filePath = await createTestMarkdownFile(
      suite.tempDir,
      'no-links.md',
      `# No Links

This document has no links at all. Just plain text content.`,
    );
    const resource = await createTestResource(filePath);

    const allContent = await indexAndQuery([resource], 'no links');
    expect(allContent).toContain('This document has no links at all');
  });

  it('should produce consistent content hash for same transform + content', async () => {
    const contentTransform = createLinkRewriteTransform('REF: {{link.text}}');
    suite.provider = await LanceDBRAGProvider.create({ dbPath: suite.dbPath, contentTransform });

    const resource = await createResourceWithLinks(
      suite.tempDir,
      'consistent-hash.md',
      `# Consistent

See [the doc](./doc.md) here.`,
      'consistent-doc',
    );

    const result1 = await suite.provider.indexResources([resource]);
    expect(result1.resourcesIndexed).toBe(1);

    const result2 = await suite.provider.indexResources([resource]);
    expect(result2.resourcesSkipped).toBe(1);
    expect(result2.resourcesIndexed).toBe(0);
  });
});
