import { describe, it, expect, beforeEach, afterEach } from 'vitest';


import { ResourceQuery } from '../src/resource-query.js';

import { createAndAddResource, createAndAddThreeResources, createAndAddTwoResources, createTwoResourcesWithLink } from './test-helpers-query.js';
import { setupResourceTestSuite } from './test-helpers.js';

const suite = setupResourceTestSuite('resource-query-');

describe('ResourceQuery basic usage', () => {
  beforeEach(suite.beforeEach);
  afterEach(suite.afterEach);

  it('should create query from array of resources', () => {
    const query = ResourceQuery.from([]);
    expect(query).toBeInstanceOf(ResourceQuery);
  });

  it('should lazily evaluate and return resources', async () => {
    const resource = await createAndAddResource(suite.tempDir, 'test.md', '# Test', suite.registry);

    const query = ResourceQuery.from([resource]);
    const results = query.execute();

    expect(results).toEqual([resource]);
  });

  it('should support chaining operations', async () => {
    const [resource1, resource2] = await createAndAddTwoResources(
      suite.tempDir,
      'file1.md',
      '# File 1',
      'file2.md',
      '# File 2',
      suite.registry
    );

    const query = ResourceQuery.from([resource1, resource2]);
    const results = query.execute();

    expect(results).toHaveLength(2);
    expect(results).toContain(resource1);
    expect(results).toContain(resource2);
  });
});

describe('ResourceQuery filter()', () => {
  beforeEach(suite.beforeEach);
  afterEach(suite.afterEach);

  it('should filter resources by predicate', async () => {
    const [resource1, resource2] = await createTwoResourcesWithLink(suite.tempDir, suite.registry);

    const results = ResourceQuery.from([resource1, resource2])
      .filter((r) => r.links.length > 0)
      .execute();

    expect(results).toHaveLength(1);
    expect(results[0]).toBe(resource1);
  });

  it('should support multiple filters', async () => {
    const [resource1, resource2, resource3] = await createAndAddThreeResources(
      suite.tempDir,
      [
        ['readme.md', '# README\n\n[Link](./guide.md)'],
        ['guide.md', '# Guide\n\n[Link1](./api.md)\n[Link2](./readme.md)'],
        ['api.md', '# API'],
      ],
      suite.registry
    );

    const query = ResourceQuery.from([resource1, resource2, resource3])
      .filter((r) => r.links.length > 0)
      .filter((r) => r.links.length > 1);

    const results = query.execute();

    expect(results).toHaveLength(1);
    expect(results[0]).toBe(resource2);
  });

  it('should return empty array when no resources match', async () => {
    const resource = await createAndAddResource(suite.tempDir, 'test.md', '# Test', suite.registry);

    const query = ResourceQuery.from([resource])
      .filter((r) => r.links.length > 10);

    const results = query.execute();

    expect(results).toHaveLength(0);
  });
});

describe('ResourceQuery map()', () => {
  beforeEach(suite.beforeEach);
  afterEach(suite.afterEach);

  it('should transform resources with map', async () => {
    const resource = await createAndAddResource(suite.tempDir, 'test.md', '# Test', suite.registry);
    const originalPath = resource.filePath;

    const query = ResourceQuery.from([resource])
      .map((r) => ({ ...r, filePath: r.filePath.toUpperCase() }));

    const results = query.execute();

    expect(results).toHaveLength(1);
    expect(results[0]?.filePath).toBe(originalPath.toUpperCase());
  });

  it('should support chaining map and filter', async () => {
    const [resource1, resource2] = await createTwoResourcesWithLink(suite.tempDir, suite.registry);

    const query = ResourceQuery.from([resource1, resource2])
      .filter((r) => r.links.length > 0)
      .map((r) => ({ ...r, id: r.id.toUpperCase() }));

    const results = query.execute();

    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe(resource1.id.toUpperCase());
  });
});

describe('ResourceQuery matchesPattern()', () => {
  beforeEach(suite.beforeEach);
  afterEach(suite.afterEach);

  it('should filter resources by glob pattern', async () => {
    const [resource1, resource2, resource3] = await createAndAddThreeResources(
      suite.tempDir,
      [
        ['docs/README.md', '# README'],
        ['docs/guide.md', '# Guide'],
        ['src/index.ts', '// Code'],
      ],
      suite.registry
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
      suite.tempDir,
      [
        ['README.md', '# README'],
        ['guide.md', '# Guide'],
        ['test.txt', 'Test'],
      ],
      suite.registry
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
      suite.tempDir,
      [
        ['docs/api.md', '# API\n\n[Link](./guide.md)'],
        ['docs/guide.md', '# Guide'],
        ['src/index.ts', '// Code'],
      ],
      suite.registry
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
  beforeEach(suite.beforeEach);
  afterEach(suite.afterEach);

  it('should convert query results to ResourceCollection', async () => {
    const [resource1, resource2] = await createAndAddTwoResources(
      suite.tempDir,
      'file1.md',
      '# File 1',
      'file2.md',
      '# File 2',
      suite.registry
    );

    const collection = ResourceQuery.from([resource1, resource2]).toCollection();

    expect(collection.size()).toBe(2);
    expect(collection.getAllResources()).toEqual([resource1, resource2]);
  });

  it('should create collection from filtered results', async () => {
    const [resource1, resource2] = await createTwoResourcesWithLink(suite.tempDir, suite.registry);

    const collection = ResourceQuery.from([resource1, resource2])
      .filter((r) => r.links.length > 0)
      .toCollection();

    expect(collection.size()).toBe(1);
    expect(collection.getAllResources()).toEqual([resource1]);
  });

  it('should support duplicate detection in collection', async () => {
    // Create two files with identical content
    const resource1 = await createAndAddResource(suite.tempDir, 'file1.md', '# Same', suite.registry);
    const resource2 = await createAndAddResource(suite.tempDir, 'file2.md', '# Same', suite.registry);

    const collection = ResourceQuery.from([resource1, resource2]).toCollection();

    const duplicates = collection.getDuplicates();
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]).toHaveLength(2);
  });
});
