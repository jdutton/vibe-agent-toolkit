
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect } from 'vitest';

import { calculateChecksum } from '../src/checksum.js';

describe('calculateChecksum', () => {
  const TEMP_DIR_PREFIX = 'checksum-test-';

  /**
   * Helper to create two test files with given content
   */
  async function createTwoFiles(content1: string, content2: string): Promise<{ tempDir: string; file1: string; file2: string }> {
    const tempDir = await fs.mkdtemp(join(tmpdir(), TEMP_DIR_PREFIX));
    const file1 = join(tempDir, 'file1.txt');
    const file2 = join(tempDir, 'file2.txt');
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await fs.writeFile(file1, content1, 'utf-8');
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await fs.writeFile(file2, content2, 'utf-8');
    return { tempDir, file1, file2 };
  }

  it('should calculate SHA-256 checksum for file content', async () => {
    const tempDir = await fs.mkdtemp(join(tmpdir(), TEMP_DIR_PREFIX));
    const testFile = join(tempDir, 'test.txt');
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await fs.writeFile(testFile, 'Hello, World!', 'utf-8');

    const checksum = await calculateChecksum(testFile);

    // Known SHA-256 of "Hello, World!"
    expect(checksum).toBe('dffd6021bb2bd5b0af676290809ec3a53191dd81c7f70a4b28688a362182986f');

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should return same checksum for same content', async () => {
    const { tempDir, file1, file2 } = await createTwoFiles('identical content', 'identical content');

    const checksum1 = await calculateChecksum(file1);
    const checksum2 = await calculateChecksum(file2);

    expect(checksum1).toBe(checksum2);

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should return different checksums for different content', async () => {
    const { tempDir, file1, file2 } = await createTwoFiles('content A', 'content B');

    const checksum1 = await calculateChecksum(file1);
    const checksum2 = await calculateChecksum(file2);

    expect(checksum1).not.toBe(checksum2);

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should throw error for non-existent file', async () => {
    await expect(
      calculateChecksum('/nonexistent/file.txt')
    ).rejects.toThrow();
  });
});
