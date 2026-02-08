

import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import { setupAsyncTempDirSuite } from '@vibe-agent-toolkit/utils';
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';

import { ResourceRegistry } from '../src/resource-registry.js';

describe('ResourceRegistry with checksum', () => {
  const suite = setupAsyncTempDirSuite('parser-checksum');
  let tempDir: string;
  let registry: ResourceRegistry;

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);

  beforeEach(async () => {
    await suite.beforeEach();
    tempDir = suite.getTempDir();
    // Create fresh registry for checksum validation
    registry = new ResourceRegistry();
  });

  it('should calculate checksum when adding resource', async () => {
    const testFile = join(tempDir, 'test.md');
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await fs.writeFile(testFile, '# Test\n\nContent here.', 'utf-8');

    const metadata = await registry.addResource(testFile);

    expect(metadata.checksum).toBeDefined();
    expect(metadata.checksum).toMatch(/^[a-f0-9]{64}$/);
  });

  it('should return same checksum for same content', async () => {
    const content = '# Same Content\n\nIdentical text.';
    const file1 = join(tempDir, 'file1.md');
    const file2 = join(tempDir, 'file2.md');
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await fs.writeFile(file1, content, 'utf-8');
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await fs.writeFile(file2, content, 'utf-8');

    const metadata1 = await registry.addResource(file1);
    const metadata2 = await registry.addResource(file2);

    expect(metadata1.checksum).toBe(metadata2.checksum);
  });

  it('should return different checksums for different content', async () => {
    const file1 = join(tempDir, 'file1.md');
    const file2 = join(tempDir, 'file2.md');
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await fs.writeFile(file1, '# Content A', 'utf-8');
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await fs.writeFile(file2, '# Content B', 'utf-8');

    const metadata1 = await registry.addResource(file1);
    const metadata2 = await registry.addResource(file2);

    expect(metadata1.checksum).not.toBe(metadata2.checksum);
  });
});
