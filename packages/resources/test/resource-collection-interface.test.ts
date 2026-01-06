import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import type { ResourceCollectionInterface } from '../src/resource-collection-interface.js';
import { ResourceRegistry } from '../src/resource-registry.js';

describe('ResourceCollectionInterface', () => {
  let tempDir: string;
  let collection: ResourceCollectionInterface;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(join(tmpdir(), 'collection-interface-'));
    collection = new ResourceRegistry();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should provide size() method', () => {
    expect(collection.size()).toBe(0);
  });

  it('should provide isEmpty() method', () => {
    expect(collection.isEmpty()).toBe(true);
  });

  it('should provide getAllResources() method', () => {
    const resources = collection.getAllResources();
    expect(resources).toEqual([]);
  });

  it('should provide getDuplicates() method', () => {
    const duplicates = collection.getDuplicates();
    expect(duplicates).toEqual([]);
  });

  it('should provide getUniqueByChecksum() method', () => {
    const unique = collection.getUniqueByChecksum();
    expect(unique).toEqual([]);
  });
});
