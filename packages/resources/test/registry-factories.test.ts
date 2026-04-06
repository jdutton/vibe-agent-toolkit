
/* eslint-disable security/detect-non-literal-fs-filename */
import { promises as fs } from 'node:fs';


import { setupAsyncTempDirSuite, safePath } from '@vibe-agent-toolkit/utils';
import { beforeEach, describe, expect, it, beforeAll, afterAll } from 'vitest';

import { ResourceRegistry } from '../src/resource-registry.js';

describe('ResourceRegistry factory methods', () => {
  const suite = setupAsyncTempDirSuite('registry-factories');
  let tempDir: string;

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);

  beforeEach(async () => {
    await suite.beforeEach();
    tempDir = suite.getTempDir();
  });

  describe('empty', () => {
    it('should create empty registry with baseDir', () => {
      const registry = ResourceRegistry.empty(tempDir);

      expect(registry.size()).toBe(0);
      expect(registry.isEmpty()).toBe(true);
      expect(registry.baseDir).toBe(tempDir);
    });

    it('should create registry that can add resources', async () => {
      const registry = ResourceRegistry.empty(tempDir);

      await fs.writeFile(safePath.join(tempDir, 'test.md'), '# Test', 'utf-8');
      const resource = await registry.addResource(safePath.join(tempDir, 'test.md'));

      expect(registry.size()).toBe(1);
      expect(resource).toBeDefined();
    });
  });

  describe('fromResources', () => {
    it('should create registry from resource array', async () => {
      await fs.writeFile(safePath.join(tempDir, 'test.md'), '# Test', 'utf-8');

      const tempRegistry = new ResourceRegistry();
      const resource = await tempRegistry.addResource(safePath.join(tempDir, 'test.md'));

      const registry = ResourceRegistry.fromResources(tempDir, [resource]);

      expect(registry.size()).toBe(1);
      expect(registry.baseDir).toBe(tempDir);
      expect(registry.getAllResources()).toEqual([resource]);
    });

    it('should build indexes from initial resources', async () => {
      await fs.writeFile(safePath.join(tempDir, 'doc1.md'), '# Same', 'utf-8');
      await fs.writeFile(safePath.join(tempDir, 'doc2.md'), '# Same', 'utf-8');

      const tempRegistry = new ResourceRegistry();
      const resource1 = await tempRegistry.addResource(safePath.join(tempDir, 'doc1.md'));
      const resource2 = await tempRegistry.addResource(safePath.join(tempDir, 'doc2.md'));

      const registry = ResourceRegistry.fromResources(tempDir, [resource1, resource2]);

      const duplicates = registry.getDuplicates();
      expect(duplicates).toHaveLength(1);
      expect(duplicates[0]).toHaveLength(2);
    });

    it('should handle empty resource array', () => {
      const registry = ResourceRegistry.fromResources(tempDir, []);

      expect(registry.size()).toBe(0);
      expect(registry.isEmpty()).toBe(true);
      expect(registry.baseDir).toBe(tempDir);
    });

    it('should support name-based lookups', async () => {
      await fs.writeFile(safePath.join(tempDir, 'README.md'), '# Root', 'utf-8');
      await fs.mkdir(safePath.join(tempDir, 'docs'), { recursive: true });
      await fs.writeFile(safePath.join(tempDir, 'docs/README.md'), '# Docs', 'utf-8');

      // Use baseDir so same-named files get unique path-relative IDs
      const tempRegistry = new ResourceRegistry({ baseDir: tempDir });
      const resource1 = await tempRegistry.addResource(safePath.join(tempDir, 'README.md'));
      const resource2 = await tempRegistry.addResource(safePath.join(tempDir, 'docs/README.md'));

      const registry = ResourceRegistry.fromResources(tempDir, [resource1, resource2]);

      const readmes = registry.getResourcesByName('README.md');
      expect(readmes).toHaveLength(2);
    });
  });

  describe('fromCrawl', () => {
    it('should create registry by crawling directory', async () => {
      await fs.writeFile(safePath.join(tempDir, 'doc1.md'), '# Doc 1', 'utf-8');
      await fs.writeFile(safePath.join(tempDir, 'doc2.md'), '# Doc 2', 'utf-8');

      const registry = await ResourceRegistry.fromCrawl({
        baseDir: tempDir,
        include: ['*.md'],
      });

      expect(registry.size()).toBe(2);
      expect(registry.baseDir).toBe(tempDir);
    });

    it('should respect exclude patterns', async () => {
      await fs.mkdir(safePath.join(tempDir, 'public'), { recursive: true });
      await fs.mkdir(safePath.join(tempDir, 'private'), { recursive: true });
      await fs.writeFile(safePath.join(tempDir, 'public/doc.md'), '# Public', 'utf-8');
      await fs.writeFile(safePath.join(tempDir, 'private/doc.md'), '# Private', 'utf-8');

      const registry = await ResourceRegistry.fromCrawl({
        baseDir: tempDir,
        include: ['**/*.md'],
        exclude: ['**/private/**'],
      });

      expect(registry.size()).toBe(1);
      const allResources = registry.getAllResources();
      expect(allResources[0]?.filePath).toContain('public');
    });

    it('should handle nested directories', async () => {
      await fs.mkdir(safePath.join(tempDir, 'docs/api'), { recursive: true });
      await fs.writeFile(safePath.join(tempDir, 'docs/api/guide.md'), '# Guide', 'utf-8');

      const registry = await ResourceRegistry.fromCrawl({
        baseDir: tempDir,
        include: ['**/*.md'],
      });

      expect(registry.size()).toBe(1);
    });

    it('should handle empty directory', async () => {
      const registry = await ResourceRegistry.fromCrawl({
        baseDir: tempDir,
        include: ['*.md'],
      });

      expect(registry.size()).toBe(0);
      expect(registry.isEmpty()).toBe(true);
    });

    it('should detect duplicates during crawl', async () => {
      await fs.writeFile(safePath.join(tempDir, 'doc1.md'), '# Same Content', 'utf-8');
      await fs.writeFile(safePath.join(tempDir, 'doc2.md'), '# Same Content', 'utf-8');

      const registry = await ResourceRegistry.fromCrawl({
        baseDir: tempDir,
        include: ['*.md'],
      });

      const duplicates = registry.getDuplicates();
      expect(duplicates).toHaveLength(1);
      expect(duplicates[0]).toHaveLength(2);
    });
  });
});
