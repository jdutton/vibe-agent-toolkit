/* eslint-disable security/detect-non-literal-fs-filename -- Test code using temp directories */
import fs from 'node:fs/promises';
import path from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { copyDirectory, verifyCaseSensitiveFilename } from '../src/fs-utils.js';
import { setupAsyncTempDirSuite } from '../src/test-helpers.js';

import { setupNestedDirectory } from './test-helpers.js';

describe('fs-utils', () => {
  const SUBDIR = 'subdir';
  const NESTED_TXT = 'nested.txt';
  const NESTED_CONTENT = 'nested content';

  const suite = setupAsyncTempDirSuite('fs-utils');
  let tempDir: string;

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);

  beforeEach(async () => {
    await suite.beforeEach();
    tempDir = suite.getTempDir();
  });

  describe('copyDirectory', () => {
    it('should copy empty directory', async () => {
      // Setup
      const srcDir = path.join(tempDir, 'src');
      const destDir = path.join(tempDir, 'dest');
      await fs.mkdir(srcDir);

      // Execute
      await copyDirectory(srcDir, destDir);

      // Verify
      const destStat = await fs.stat(destDir);
      expect(destStat.isDirectory()).toBe(true);

      const destEntries = await fs.readdir(destDir);
      expect(destEntries).toHaveLength(0);
    });

    it('should copy directory with files', async () => {
      // Setup
      const srcDir = path.join(tempDir, 'src');
      const destDir = path.join(tempDir, 'dest');
      await fs.mkdir(srcDir);
      await fs.writeFile(path.join(srcDir, 'file1.txt'), 'content1');
      await fs.writeFile(path.join(srcDir, 'file2.txt'), 'content2');

      // Execute
      await copyDirectory(srcDir, destDir);

      // Verify
      const file1Content = await fs.readFile(path.join(destDir, 'file1.txt'), 'utf-8');
      const file2Content = await fs.readFile(path.join(destDir, 'file2.txt'), 'utf-8');
      expect(file1Content).toBe('content1');
      expect(file2Content).toBe('content2');
    });

    it('should copy nested directories', async () => {
      // Setup
      const { srcDir, destDir } = await setupNestedDirectory(
        tempDir,
        SUBDIR,
        NESTED_TXT,
        NESTED_CONTENT
      );

      // Execute
      await copyDirectory(srcDir, destDir);

      // Verify
      const nestedContent = await fs.readFile(
        path.join(destDir, SUBDIR, NESTED_TXT),
        'utf-8'
      );
      expect(nestedContent).toBe(NESTED_CONTENT);
    });

    it('should copy deeply nested directories', async () => {
      // Setup
      const srcDir = path.join(tempDir, 'src');
      const destDir = path.join(tempDir, 'dest');
      await fs.mkdir(path.join(srcDir, 'a', 'b', 'c'), { recursive: true });
      await fs.writeFile(path.join(srcDir, 'a', 'b', 'c', 'deep.txt'), 'deep content');

      // Execute
      await copyDirectory(srcDir, destDir);

      // Verify
      const deepContent = await fs.readFile(
        path.join(destDir, 'a', 'b', 'c', 'deep.txt'),
        'utf-8'
      );
      expect(deepContent).toBe('deep content');
    });

    it('should copy mixed files and directories', async () => {
      // Setup
      const { srcDir, destDir } = await setupNestedDirectory(
        tempDir,
        SUBDIR,
        NESTED_TXT,
        NESTED_CONTENT
      );
      await fs.writeFile(path.join(srcDir, 'root.txt'), 'root content');

      // Execute
      await copyDirectory(srcDir, destDir);

      // Verify
      const rootContent = await fs.readFile(path.join(destDir, 'root.txt'), 'utf-8');
      const nestedContent = await fs.readFile(
        path.join(destDir, SUBDIR, NESTED_TXT),
        'utf-8'
      );
      expect(rootContent).toBe('root content');
      expect(nestedContent).toBe(NESTED_CONTENT);
    });

    it('should create destination directory if it does not exist', async () => {
      // Setup
      const srcDir = path.join(tempDir, 'src');
      const destDir = path.join(tempDir, 'non', 'existent', 'dest');
      await fs.mkdir(srcDir);
      await fs.writeFile(path.join(srcDir, 'file.txt'), 'content');

      // Execute
      await copyDirectory(srcDir, destDir);

      // Verify
      const fileContent = await fs.readFile(path.join(destDir, 'file.txt'), 'utf-8');
      expect(fileContent).toBe('content');
    });

    it('should preserve file contents', async () => {
      // Setup
      const srcDir = path.join(tempDir, 'src');
      const destDir = path.join(tempDir, 'dest');
      await fs.mkdir(srcDir);
      const binaryContent = Buffer.from([0x00, 0x01, 0x02, 0xff]);
      await fs.writeFile(path.join(srcDir, 'binary.dat'), binaryContent);

      // Execute
      await copyDirectory(srcDir, destDir);

      // Verify
      const copiedContent = await fs.readFile(path.join(destDir, 'binary.dat'));
      expect(Buffer.compare(copiedContent, binaryContent)).toBe(0);
    });

    it('should handle multiple files in nested directories', async () => {
      // Setup
      const srcDir = path.join(tempDir, 'src');
      const destDir = path.join(tempDir, 'dest');
      await fs.mkdir(path.join(srcDir, 'dir1'), { recursive: true });
      await fs.mkdir(path.join(srcDir, 'dir2'), { recursive: true });
      await fs.writeFile(path.join(srcDir, 'dir1', 'file1.txt'), 'content1');
      await fs.writeFile(path.join(srcDir, 'dir1', 'file2.txt'), 'content2');
      await fs.writeFile(path.join(srcDir, 'dir2', 'file3.txt'), 'content3');

      // Execute
      await copyDirectory(srcDir, destDir);

      // Verify
      const file1 = await fs.readFile(path.join(destDir, 'dir1', 'file1.txt'), 'utf-8');
      const file2 = await fs.readFile(path.join(destDir, 'dir1', 'file2.txt'), 'utf-8');
      const file3 = await fs.readFile(path.join(destDir, 'dir2', 'file3.txt'), 'utf-8');
      expect(file1).toBe('content1');
      expect(file2).toBe('content2');
      expect(file3).toBe('content3');
    });

    it('should throw error when source directory does not exist', async () => {
      // Setup
      const srcDir = path.join(tempDir, 'nonexistent');
      const destDir = path.join(tempDir, 'dest');

      // Execute & Verify
      await expect(copyDirectory(srcDir, destDir)).rejects.toThrow();
    });

    it('should throw error when source is not a directory', async () => {
      // Setup
      const srcFile = path.join(tempDir, 'file.txt');
      const destDir = path.join(tempDir, 'dest');
      await fs.writeFile(srcFile, 'content');

      // Execute & Verify
      await expect(copyDirectory(srcFile, destDir)).rejects.toThrow();
    });
  });

  describe('verifyCaseSensitiveFilename', () => {
    const TEST_FILE = 'TestFile.txt';

    it('should return exists=true for exact case match', async () => {
      // Setup
      const filePath = path.join(tempDir, TEST_FILE);
      await fs.writeFile(filePath, 'content');

      // Execute
      const result = await verifyCaseSensitiveFilename(filePath);

      // Verify
      expect(result.exists).toBe(true);
      expect(result.actualName).toBe(TEST_FILE);
    });

    it('should return exists=false for case mismatch', async () => {
      // Setup
      const actualPath = path.join(tempDir, TEST_FILE);
      const wrongCasePath = path.join(tempDir, 'testfile.txt');
      await fs.writeFile(actualPath, 'content');

      // Execute
      const result = await verifyCaseSensitiveFilename(wrongCasePath);

      // Verify
      // On case-insensitive filesystems, the file will be found
      // but case won't match
      expect(result.exists).toBe(false);
      expect(result.actualName).toBe(TEST_FILE);
    });

    it('should return exists=false and null actualName for missing file', async () => {
      // Setup
      const filePath = path.join(tempDir, 'NonExistent.txt');

      // Execute
      const result = await verifyCaseSensitiveFilename(filePath);

      // Verify
      expect(result.exists).toBe(false);
      expect(result.actualName).toBe(null);
    });

    it('should handle files in subdirectories with exact case', async () => {
      // Setup
      const subDir = path.join(tempDir, 'SubDir');
      await fs.mkdir(subDir);
      const filePath = path.join(subDir, 'File.txt');
      await fs.writeFile(filePath, 'content');

      // Execute
      const result = await verifyCaseSensitiveFilename(filePath);

      // Verify
      expect(result.exists).toBe(true);
      expect(result.actualName).toBe('File.txt');
    });

    it('should detect case mismatch in subdirectory filename', async () => {
      // Setup
      const subDir = path.join(tempDir, 'SubDir');
      await fs.mkdir(subDir);
      const actualPath = path.join(subDir, 'File.txt');
      const wrongCasePath = path.join(subDir, 'file.txt');
      await fs.writeFile(actualPath, 'content');

      // Execute
      const result = await verifyCaseSensitiveFilename(wrongCasePath);

      // Verify
      expect(result.exists).toBe(false);
      expect(result.actualName).toBe('File.txt');
    });
  });
});
