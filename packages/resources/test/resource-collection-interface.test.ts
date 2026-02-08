import { setupAsyncTempDirSuite } from '@vibe-agent-toolkit/utils';
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';

import type { ResourceCollectionInterface } from '../src/resource-collection-interface.js';
import { ResourceRegistry } from '../src/resource-registry.js';

describe('ResourceCollectionInterface', () => {
  const suite = setupAsyncTempDirSuite('collection-interface');
  let collection: ResourceCollectionInterface;

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);

  beforeEach(async () => {
    await suite.beforeEach();
    collection = new ResourceRegistry();
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
