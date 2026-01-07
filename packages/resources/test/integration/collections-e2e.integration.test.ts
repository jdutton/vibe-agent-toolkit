import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { toForwardSlash } from '@vibe-agent-toolkit/utils';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { ResourceCollection } from '../../src/resource-collection.js';
import { ResourceQuery } from '../../src/resource-query.js';
import { ResourceRegistry } from '../../src/resource-registry.js';

describe('Resource Collection System - End to End', () => {
  let tempDir: string;
  let registry: ResourceRegistry;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(join(tmpdir(), 'e2e-collections-'));
    registry = new ResourceRegistry();

    // Create test directory structure
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await fs.mkdir(join(tempDir, 'docs/api'), { recursive: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await fs.mkdir(join(tempDir, 'docs/guides'), { recursive: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await fs.mkdir(join(tempDir, 'docs/internal'), { recursive: true });

    // Create test files with varied content
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await fs.writeFile(join(tempDir, 'README.md'), '# Project README\n\nWelcome to the project.', 'utf-8');
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await fs.writeFile(join(tempDir, 'docs/api/reference.md'), '# API Reference\n\nAPI documentation here.', 'utf-8');
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await fs.writeFile(join(tempDir, 'docs/api/guide.md'), '# API Guide\n\nGuide to using the API.', 'utf-8');
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await fs.writeFile(join(tempDir, 'docs/guides/getting-started.md'), '# Getting Started\n\nStart here.', 'utf-8');
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await fs.writeFile(join(tempDir, 'docs/internal/notes.md'), '# Internal Notes\n\nPrivate notes.', 'utf-8');

    // Create duplicate content - same as README
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await fs.writeFile(join(tempDir, 'docs/guides/README.md'), '# Project README\n\nWelcome to the project.', 'utf-8');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should crawl directory and build complete registry', async () => {
    await registry.crawl({
      baseDir: tempDir,
      include: ['**/*.md'],
    });

    expect(registry.size()).toBe(6);
    expect(registry.isEmpty()).toBe(false);
  });

  it('should query resources with glob patterns', async () => {
    await registry.crawl({
      baseDir: tempDir,
      include: ['**/*.md'],
    });

    const apiDocs = ResourceQuery.from(registry.getAllResources())
      .matchesPattern('**/api/**')
      .execute();

    expect(apiDocs).toHaveLength(2);
    expect(apiDocs.every((r) => toForwardSlash(r.filePath).includes('/api/'))).toBe(true);
  });

  it('should filter resources with multiple criteria', async () => {
    await registry.crawl({
      baseDir: tempDir,
      include: ['**/*.md'],
    });

    const filtered = ResourceQuery.from(registry.getAllResources())
      .matchesPattern('**/docs/**')
      .filter((r) => r.sizeBytes > 20)
      .execute();

    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.every((r) => toForwardSlash(r.filePath).includes('/docs/'))).toBe(true);
  });

  it('should detect content-based duplicates', async () => {
    await registry.crawl({
      baseDir: tempDir,
      include: ['**/*.md'],
    });

    const duplicates = registry.getDuplicates();

    expect(duplicates).toHaveLength(1); // One duplicate group
    expect(duplicates[0]).toHaveLength(2); // README.md and docs/guides/README.md
    expect(duplicates[0]?.every((r) => r.filePath.endsWith('README.md'))).toBe(true);
  });

  it('should get unique resources by checksum', async () => {
    await registry.crawl({
      baseDir: tempDir,
      include: ['**/*.md'],
    });

    const unique = registry.getUniqueByChecksum();

    expect(unique).toHaveLength(5); // 6 total - 1 duplicate = 5 unique
  });

  it('should combine query with collection operations', async () => {
    await registry.crawl({
      baseDir: tempDir,
      include: ['**/*.md'],
    });

    // Query for all resources, then get collection with duplicates
    const collection = ResourceQuery.from(registry.getAllResources())
      .filter((r) => r.sizeBytes > 10)
      .toCollection();

    expect(collection.size()).toBe(6);

    const duplicates = collection.getDuplicates();
    expect(duplicates).toHaveLength(1); // README.md duplicated
    expect(duplicates[0]).toHaveLength(2);
  });

  it('should support name-based lookups', async () => {
    await registry.crawl({
      baseDir: tempDir,
      include: ['**/*.md'],
    });

    const readmeFiles = registry.getResourcesByName('README.md');

    expect(readmeFiles).toHaveLength(2);
    expect(readmeFiles.every((r) => r.filePath.endsWith('README.md'))).toBe(true);
  });

  it('should support checksum-based lookups', async () => {
    await registry.crawl({
      baseDir: tempDir,
      include: ['**/*.md'],
    });

    // Get first README's checksum
    const readme = registry.getResourcesByName('README.md')[0];
    expect(readme).toBeDefined();

    if (!readme) {
      throw new Error('README not found');
    }

    const sameContent = registry.getResourcesByChecksum(readme.checksum);
    expect(sameContent).toHaveLength(2);
  });

  it('should exclude directories with patterns', async () => {
    await registry.crawl({
      baseDir: tempDir,
      include: ['**/*.md'],
      exclude: ['**/internal/**'],
    });

    expect(registry.size()).toBe(5);
    const all = registry.getAllResources();
    expect(all.every((r) => !toForwardSlash(r.filePath).includes('/internal/'))).toBe(true);
  });

  it('should transform query results before collecting', async () => {
    await registry.crawl({
      baseDir: tempDir,
      include: ['**/*.md'],
    });

    const collection = ResourceQuery.from(registry.getAllResources())
      .filter((r) => toForwardSlash(r.filePath).includes('/docs/'))
      .map((r) => ({ ...r, id: r.id.toUpperCase() }))
      .toCollection();

    expect(collection.size()).toBe(5);
    const all = collection.getAllResources();
    expect(all.every((r) => r.id === r.id.toUpperCase())).toBe(true);
  });

  it('should support complex workflow: filter, dedupe, collect', async () => {
    await registry.crawl({
      baseDir: tempDir,
      include: ['**/*.md'],
    });

    // 1. Get all resources (includes duplicates)
    const allResources = ResourceQuery.from(registry.getAllResources())
      .filter((r) => r.sizeBytes > 15)
      .execute();

    // 2. Create collection and get unique by checksum
    const collection = new ResourceCollection(allResources);
    const unique = collection.getUniqueByChecksum();

    // 3. Verify results - 6 total, 1 duplicate = 5 unique
    expect(unique).toHaveLength(5);

    // 4. Verify we can query the unique set
    const uniqueApiDocs = ResourceQuery.from(unique)
      .matchesPattern('**/api/**')
      .execute();

    expect(uniqueApiDocs).toHaveLength(2);
  });
});
