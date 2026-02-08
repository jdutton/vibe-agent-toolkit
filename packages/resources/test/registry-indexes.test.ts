import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import { setupAsyncTempDirSuite } from '@vibe-agent-toolkit/utils';
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';

import { ResourceRegistry } from '../src/resource-registry.js';

describe('ResourceRegistry indexes', () => {
  const suite = setupAsyncTempDirSuite('registry-indexes');
  let tempDir: string;
  let registry: ResourceRegistry;

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);

  beforeEach(async () => {
    await suite.beforeEach();
    tempDir = suite.getTempDir();
    // Initialize fresh registry for index tests
    registry = new ResourceRegistry();
  });

  describe('getResourcesByName', () => {
    it('should return empty array for non-existent name', () => {
      const resources = registry.getResourcesByName('nonexistent.md');
      expect(resources).toEqual([]);
    });

    it('should return resources by filename', async () => {
      const file = join(tempDir, 'test.md');
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      await fs.writeFile(file, '# Test', 'utf-8');
      await registry.addResource(file);

      const resources = registry.getResourcesByName('test.md');
      expect(resources).toHaveLength(1);
      expect(resources[0]?.filePath).toBe(file);
    });

    it('should return multiple resources with same name in different directories', async () => {
      const dir1 = join(tempDir, 'dir1');
      const dir2 = join(tempDir, 'dir2');
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      await fs.mkdir(dir1);
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      await fs.mkdir(dir2);
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      await fs.writeFile(join(dir1, 'README.md'), '# Dir 1', 'utf-8');
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      await fs.writeFile(join(dir2, 'README.md'), '# Dir 2', 'utf-8');

      await registry.addResource(join(dir1, 'README.md'));
      await registry.addResource(join(dir2, 'README.md'));

      const resources = registry.getResourcesByName('README.md');
      expect(resources).toHaveLength(2);
    });
  });

  describe('getResourcesByChecksum', () => {
    it('should return empty array for non-existent checksum', () => {
      const fakeChecksum = 'a'.repeat(64);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const resources = registry.getResourcesByChecksum(fakeChecksum as any);
      expect(resources).toEqual([]);
    });

    it('should return resource by checksum', async () => {
      const file = join(tempDir, 'test.md');
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      await fs.writeFile(file, '# Test Content', 'utf-8');
      const metadata = await registry.addResource(file);

      const resources = registry.getResourcesByChecksum(metadata.checksum);
      expect(resources).toHaveLength(1);
      expect(resources[0]?.filePath).toBe(file);
    });

    it('should return multiple resources with identical content', async () => {
      const content = '# Identical Content';
      const file1 = join(tempDir, 'file1.md');
      const file2 = join(tempDir, 'file2.md');
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      await fs.writeFile(file1, content, 'utf-8');
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      await fs.writeFile(file2, content, 'utf-8');

      const meta1 = await registry.addResource(file1);
      await registry.addResource(file2);

      const resources = registry.getResourcesByChecksum(meta1.checksum);
      expect(resources).toHaveLength(2);
      expect(resources.map(r => r.filePath)).toContain(file1);
      expect(resources.map(r => r.filePath)).toContain(file2);
    });
  });
});
