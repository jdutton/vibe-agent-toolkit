import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { ResourceCollection } from '../src/resource-collection.js';
import { ResourceRegistry } from '../src/resource-registry.js';

import { createAndAddResource, createAndAddTwoResources } from './test-helpers-query.js';

describe('ResourceCollection', () => {
  let tempDir: string;
  let registry: ResourceRegistry;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(join(tmpdir(), 'resource-collection-'));
    registry = new ResourceRegistry();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should create collection from array', async () => {
    const resource = await createAndAddResource(tempDir, 'test.md', '# Test', registry);
    const collection = new ResourceCollection([resource]);
    expect(collection.size()).toBe(1);
  });

  it('should report size correctly', async () => {
    const [resource1, resource2] = await createAndAddTwoResources(
      tempDir,
      'file1.md',
      '# File 1',
      'file2.md',
      '# File 2',
      registry
    );
    const collection = new ResourceCollection([resource1, resource2]);
    expect(collection.size()).toBe(2);
  });

  it('should detect when empty', () => {
    const collection = new ResourceCollection([]);
    expect(collection.isEmpty()).toBe(true);
  });

  it('should detect when not empty', async () => {
    const resource = await createAndAddResource(tempDir, 'test.md', '# Test', registry);
    const collection = new ResourceCollection([resource]);
    expect(collection.isEmpty()).toBe(false);
  });

  it('should return all resources', async () => {
    const [resource1, resource2] = await createAndAddTwoResources(
      tempDir,
      'file1.md',
      '# File 1',
      'file2.md',
      '# File 2',
      registry
    );
    const collection = new ResourceCollection([resource1, resource2]);
    const all = collection.getAllResources();
    expect(all).toHaveLength(2);
    expect(all).toContain(resource1);
    expect(all).toContain(resource2);
  });

  it('should detect duplicates by checksum', async () => {
    // Create two files with identical content
    const resource1 = await createAndAddResource(tempDir, 'file1.md', '# Same', registry);
    const resource2 = await createAndAddResource(tempDir, 'file2.md', '# Same', registry);

    const collection = new ResourceCollection([resource1, resource2]);
    const duplicates = collection.getDuplicates();

    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]).toHaveLength(2);
    expect(duplicates[0]).toContain(resource1);
    expect(duplicates[0]).toContain(resource2);
  });

  it('should return empty array when no duplicates', async () => {
    const [resource1, resource2] = await createAndAddTwoResources(
      tempDir,
      'file1.md',
      '# File 1',
      'file2.md',
      '# File 2',
      registry
    );
    const collection = new ResourceCollection([resource1, resource2]);
    const duplicates = collection.getDuplicates();
    expect(duplicates).toHaveLength(0);
  });

  it('should return unique resources by checksum', async () => {
    // Create three files: two with identical content, one unique
    const resource1 = await createAndAddResource(tempDir, 'file1.md', '# Same', registry);
    const resource2 = await createAndAddResource(tempDir, 'file2.md', '# Same', registry);
    const resource3 = await createAndAddResource(tempDir, 'file3.md', '# Different', registry);

    const collection = new ResourceCollection([resource1, resource2, resource3]);
    const unique = collection.getUniqueByChecksum();

    expect(unique).toHaveLength(2);
    // Should have one from the duplicate pair and the unique one
    expect(unique).toContain(resource3);
    // Should have either resource1 or resource2 (first encountered)
    const hasDuplicateRep = unique.includes(resource1) || unique.includes(resource2);
    expect(hasDuplicateRep).toBe(true);
  });
});
