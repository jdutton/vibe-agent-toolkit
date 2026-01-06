import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { ResourceQuery } from '../src/resource-query.js';
import { ResourceRegistry } from '../src/resource-registry.js';

import { createAndAddResource, createAndAddTwoResources, createAndAddThreeResources, createTwoResourcesWithLink } from './test-helpers-query.js';

describe('ResourceQuery basic usage', () => {
  let tempDir: string;
  let registry: ResourceRegistry;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(join(tmpdir(), 'resource-query-'));
    registry = new ResourceRegistry();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should create query from array of resources', () => {
    const query = ResourceQuery.from([]);
    expect(query).toBeInstanceOf(ResourceQuery);
  });

  it('should lazily evaluate and return resources', async () => {
    const resource = await createAndAddResource(tempDir, 'test.md', '# Test', registry);

    const query = ResourceQuery.from([resource]);
    const results = query.execute();

    expect(results).toEqual([resource]);
  });

  it('should support chaining operations', async () => {
    const [resource1, resource2] = await createAndAddTwoResources(
      tempDir,
      'file1.md',
      '# File 1',
      'file2.md',
      '# File 2',
      registry
    );

    const query = ResourceQuery.from([resource1, resource2]);
    const results = query.execute();

    expect(results).toHaveLength(2);
    expect(results).toContain(resource1);
    expect(results).toContain(resource2);
  });
});

describe('ResourceQuery filter()', () => {
  let tempDir: string;
  let registry: ResourceRegistry;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(join(tmpdir(), 'resource-query-filter-'));
    registry = new ResourceRegistry();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should filter resources by predicate', async () => {
    const [resource1, resource2] = await createTwoResourcesWithLink(tempDir, registry);

    const query = ResourceQuery.from([resource1, resource2])
      .filter((r) => r.links.length > 0);

    const results = query.execute();

    expect(results).toHaveLength(1);
    expect(results[0]).toBe(resource1);
  });

  it('should support multiple filters', async () => {
    const [resource1, resource2, resource3] = await createAndAddThreeResources(
      tempDir,
      'readme.md',
      '# README\n\n[Link](./guide.md)',
      'guide.md',
      '# Guide\n\n[Link1](./api.md)\n[Link2](./readme.md)',
      'api.md',
      '# API',
      registry
    );

    const query = ResourceQuery.from([resource1, resource2, resource3])
      .filter((r) => r.links.length > 0)
      .filter((r) => r.links.length > 1);

    const results = query.execute();

    expect(results).toHaveLength(1);
    expect(results[0]).toBe(resource2);
  });

  it('should return empty array when no resources match', async () => {
    const resource = await createAndAddResource(tempDir, 'test.md', '# Test', registry);

    const query = ResourceQuery.from([resource])
      .filter((r) => r.links.length > 10);

    const results = query.execute();

    expect(results).toHaveLength(0);
  });
});

describe('ResourceQuery map()', () => {
  let tempDir: string;
  let registry: ResourceRegistry;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(join(tmpdir(), 'resource-query-map-'));
    registry = new ResourceRegistry();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should transform resources with map', async () => {
    const resource = await createAndAddResource(tempDir, 'test.md', '# Test', registry);
    const originalPath = resource.filePath;

    const query = ResourceQuery.from([resource])
      .map((r) => ({ ...r, filePath: r.filePath.toUpperCase() }));

    const results = query.execute();

    expect(results).toHaveLength(1);
    expect(results[0]?.filePath).toBe(originalPath.toUpperCase());
  });

  it('should support chaining map and filter', async () => {
    const [resource1, resource2] = await createTwoResourcesWithLink(tempDir, registry);

    const query = ResourceQuery.from([resource1, resource2])
      .filter((r) => r.links.length > 0)
      .map((r) => ({ ...r, id: r.id.toUpperCase() }));

    const results = query.execute();

    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe(resource1.id.toUpperCase());
  });
});

describe('ResourceQuery matchesPattern()', () => {
  let tempDir: string;
  let registry: ResourceRegistry;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(join(tmpdir(), 'resource-query-pattern-'));
    registry = new ResourceRegistry();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should filter resources by glob pattern', async () => {
    const [resource1, resource2, resource3] = await createAndAddThreeResources(
      tempDir,
      'docs/README.md',
      '# README',
      'docs/guide.md',
      '# Guide',
      'src/index.ts',
      '// Code',
      registry
    );

    const query = ResourceQuery.from([resource1, resource2, resource3])
      .matchesPattern('**/docs/**');

    const results = query.execute();

    expect(results).toHaveLength(2);
    expect(results).toContain(resource1);
    expect(results).toContain(resource2);
  });

  it('should support filename patterns', async () => {
    const [resource1, resource2, resource3] = await createAndAddThreeResources(
      tempDir,
      'README.md',
      '# README',
      'guide.md',
      '# Guide',
      'test.txt',
      'Test',
      registry
    );

    const query = ResourceQuery.from([resource1, resource2, resource3])
      .matchesPattern('*.md');

    const results = query.execute();

    expect(results).toHaveLength(2);
    expect(results).toContain(resource1);
    expect(results).toContain(resource2);
  });

  it('should combine pattern matching with other operations', async () => {
    const [resource1, resource2, resource3] = await createAndAddThreeResources(
      tempDir,
      'docs/api.md',
      '# API\n\n[Link](./guide.md)',
      'docs/guide.md',
      '# Guide',
      'src/index.ts',
      '// Code',
      registry
    );

    const query = ResourceQuery.from([resource1, resource2, resource3])
      .matchesPattern('**/docs/**')
      .filter(r => r.links.length > 0);

    const results = query.execute();

    expect(results).toHaveLength(1);
    expect(results[0]).toBe(resource1);
  });
});

describe('ResourceQuery toCollection()', () => {
  let tempDir: string;
  let registry: ResourceRegistry;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(join(tmpdir(), 'resource-query-collection-'));
    registry = new ResourceRegistry();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should convert query results to ResourceCollection', async () => {
    const [resource1, resource2] = await createAndAddTwoResources(
      tempDir,
      'file1.md',
      '# File 1',
      'file2.md',
      '# File 2',
      registry
    );

    const collection = ResourceQuery.from([resource1, resource2]).toCollection();

    expect(collection.size()).toBe(2);
    expect(collection.getAllResources()).toEqual([resource1, resource2]);
  });

  it('should create collection from filtered results', async () => {
    const [resource1, resource2] = await createTwoResourcesWithLink(tempDir, registry);

    const collection = ResourceQuery.from([resource1, resource2])
      .filter((r) => r.links.length > 0)
      .toCollection();

    expect(collection.size()).toBe(1);
    expect(collection.getAllResources()).toEqual([resource1]);
  });

  it('should support duplicate detection in collection', async () => {
    // Create two files with identical content
    const resource1 = await createAndAddResource(tempDir, 'file1.md', '# Same', registry);
    const resource2 = await createAndAddResource(tempDir, 'file2.md', '# Same', registry);

    const collection = ResourceQuery.from([resource1, resource2]).toCollection();

    const duplicates = collection.getDuplicates();
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]).toHaveLength(2);
  });
});
