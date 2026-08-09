/* eslint-disable security/detect-non-literal-fs-filename -- Test code using temp directories */
import fs from 'node:fs/promises';

import { safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  classifyFilenameCase,
  copyDirectory,
  FsLookupCache,
  readSiblingNames,
  verifyCaseSensitiveFilename,
} from '../src/fs-utils.js';
import type { SiblingNames } from '../src/fs-utils.js';
import { canCreateSymlinks, setupAsyncTempDirSuite } from '../src/test-helpers.js';

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
      const srcDir = safePath.join(tempDir, 'src');
      const destDir = safePath.join(tempDir, 'dest');
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
      const srcDir = safePath.join(tempDir, 'src');
      const destDir = safePath.join(tempDir, 'dest');
      await fs.mkdir(srcDir);
      await fs.writeFile(safePath.join(srcDir, 'file1.txt'), 'content1');
      await fs.writeFile(safePath.join(srcDir, 'file2.txt'), 'content2');

      // Execute
      await copyDirectory(srcDir, destDir);

      // Verify
      const file1Content = await fs.readFile(safePath.join(destDir, 'file1.txt'), 'utf-8');
      const file2Content = await fs.readFile(safePath.join(destDir, 'file2.txt'), 'utf-8');
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
        safePath.join(destDir, SUBDIR, NESTED_TXT),
        'utf-8'
      );
      expect(nestedContent).toBe(NESTED_CONTENT);
    });

    it('should copy deeply nested directories', async () => {
      // Setup
      const srcDir = safePath.join(tempDir, 'src');
      const destDir = safePath.join(tempDir, 'dest');
      await fs.mkdir(safePath.join(srcDir, 'a', 'b', 'c'), { recursive: true });
      await fs.writeFile(safePath.join(srcDir, 'a', 'b', 'c', 'deep.txt'), 'deep content');

      // Execute
      await copyDirectory(srcDir, destDir);

      // Verify
      const deepContent = await fs.readFile(
        safePath.join(destDir, 'a', 'b', 'c', 'deep.txt'),
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
      await fs.writeFile(safePath.join(srcDir, 'root.txt'), 'root content');

      // Execute
      await copyDirectory(srcDir, destDir);

      // Verify
      const rootContent = await fs.readFile(safePath.join(destDir, 'root.txt'), 'utf-8');
      const nestedContent = await fs.readFile(
        safePath.join(destDir, SUBDIR, NESTED_TXT),
        'utf-8'
      );
      expect(rootContent).toBe('root content');
      expect(nestedContent).toBe(NESTED_CONTENT);
    });

    it('should create destination directory if it does not exist', async () => {
      // Setup
      const srcDir = safePath.join(tempDir, 'src');
      const destDir = safePath.join(tempDir, 'non', 'existent', 'dest');
      await fs.mkdir(srcDir);
      await fs.writeFile(safePath.join(srcDir, 'file.txt'), 'content');

      // Execute
      await copyDirectory(srcDir, destDir);

      // Verify
      const fileContent = await fs.readFile(safePath.join(destDir, 'file.txt'), 'utf-8');
      expect(fileContent).toBe('content');
    });

    it('should preserve file contents', async () => {
      // Setup
      const srcDir = safePath.join(tempDir, 'src');
      const destDir = safePath.join(tempDir, 'dest');
      await fs.mkdir(srcDir);
      const binaryContent = Buffer.from([0x00, 0x01, 0x02, 0xff]);
      await fs.writeFile(safePath.join(srcDir, 'binary.dat'), binaryContent);

      // Execute
      await copyDirectory(srcDir, destDir);

      // Verify
      const copiedContent = await fs.readFile(safePath.join(destDir, 'binary.dat'));
      expect(Buffer.compare(copiedContent, binaryContent)).toBe(0);
    });

    it('should handle multiple files in nested directories', async () => {
      // Setup
      const srcDir = safePath.join(tempDir, 'src');
      const destDir = safePath.join(tempDir, 'dest');
      await fs.mkdir(safePath.join(srcDir, 'dir1'), { recursive: true });
      await fs.mkdir(safePath.join(srcDir, 'dir2'), { recursive: true });
      await fs.writeFile(safePath.join(srcDir, 'dir1', 'file1.txt'), 'content1');
      await fs.writeFile(safePath.join(srcDir, 'dir1', 'file2.txt'), 'content2');
      await fs.writeFile(safePath.join(srcDir, 'dir2', 'file3.txt'), 'content3');

      // Execute
      await copyDirectory(srcDir, destDir);

      // Verify
      const file1 = await fs.readFile(safePath.join(destDir, 'dir1', 'file1.txt'), 'utf-8');
      const file2 = await fs.readFile(safePath.join(destDir, 'dir1', 'file2.txt'), 'utf-8');
      const file3 = await fs.readFile(safePath.join(destDir, 'dir2', 'file3.txt'), 'utf-8');
      expect(file1).toBe('content1');
      expect(file2).toBe('content2');
      expect(file3).toBe('content3');
    });

    it('should throw error when source directory does not exist', async () => {
      // Setup
      const srcDir = safePath.join(tempDir, 'nonexistent');
      const destDir = safePath.join(tempDir, 'dest');

      // Execute & Verify
      await expect(copyDirectory(srcDir, destDir)).rejects.toThrow();
    });

    it('should throw error when source is not a directory', async () => {
      // Setup
      const srcFile = safePath.join(tempDir, 'file.txt');
      const destDir = safePath.join(tempDir, 'dest');
      await fs.writeFile(srcFile, 'content');

      // Execute & Verify
      await expect(copyDirectory(srcFile, destDir)).rejects.toThrow();
    });
  });

  describe('FsLookupCache', () => {
    it('reads a directory once no matter how many lookups hit it', async () => {
      await fs.writeFile(safePath.join(tempDir, 'a.txt'), '');
      const cache = new FsLookupCache();
      const spy = vi.spyOn(fs, 'readdir');

      await cache.readdir(tempDir);
      await cache.readdir(tempDir);
      await cache.readdir(tempDir);

      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    });

    it('collapses concurrent lookups of the same directory to one syscall', async () => {
      const cache = new FsLookupCache();
      const spy = vi.spyOn(fs, 'readdir');

      // Fired before the first readdir settles: without in-flight promise sharing
      // each of these would start its own syscall.
      const results = await Promise.all([
        cache.readdir(tempDir),
        cache.readdir(tempDir),
        cache.readdir(tempDir),
      ]);

      expect(spy).toHaveBeenCalledTimes(1);
      expect(results[0]).toBe(results[1]);
      spy.mockRestore();
    });

    it('caches the unreadable-directory answer as null without re-spawning the syscall', async () => {
      const cache = new FsLookupCache();
      const missing = safePath.join(tempDir, 'no-such-dir');
      const spy = vi.spyOn(fs, 'readdir');

      expect(await cache.readdir(missing)).toBe(null);
      expect(await cache.readdir(missing)).toBe(null);

      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    });

    it('memoizes realpath and falls back to a resolved path when it fails', async () => {
      const cache = new FsLookupCache();
      const spy = vi.spyOn(fs, 'realpath');

      const real = await cache.realpath(tempDir);
      expect(await cache.realpath(tempDir)).toBe(real);
      expect(spy).toHaveBeenCalledTimes(1);

      const missing = safePath.join(tempDir, 'no-such-path');
      expect(await cache.realpath(missing)).toBe(safePath.resolve(missing));
      spy.mockRestore();
    });

    it('probes a path once however many times it is asked about', async () => {
      const filePath = safePath.join(tempDir, 'probed.txt');
      await fs.writeFile(filePath, '');
      const cache = new FsLookupCache();

      const first = cache.probe(filePath);
      cache.probe(filePath);
      cache.probe(filePath);

      // The counter is the assertion that dies when the memo dies. Every
      // assertion below about the VALUES still passes without a memo.
      expect(cache.probeStats).toEqual({ probes: 3, misses: 1 });
      expect(first).toEqual({ exists: true, isDirectory: false });
      expect(cache.probe(filePath)).toBe(first);
    });

    it('records a directory as existing and a directory', async () => {
      const dirPath = safePath.join(tempDir, 'a-directory');
      await fs.mkdir(dirPath);
      const cache = new FsLookupCache();

      expect(cache.probe(dirPath)).toEqual({ exists: true, isDirectory: true });
    });

    it('records an absent path as absent with no kind answer, and memoizes that too', () => {
      const cache = new FsLookupCache();
      const missing = safePath.join(tempDir, 'not-here.txt');

      expect(cache.probe(missing)).toEqual({ exists: false, isDirectory: null });
      cache.probe(missing);

      // The absent answer is cached: re-asking is the same failed syscall.
      expect(cache.probeStats).toEqual({ probes: 2, misses: 1 });
    });

    it('reports a dangling symlink as absent, matching existsSync rather than lstat', async ({ skip }) => {
      // Windows CI agents often lack the symlink privilege. Say so rather than
      // no-op: a silently skipped symlink case reads as a passing test.
      if (!canCreateSymlinks(tempDir)) skip();

      const dangling = safePath.join(tempDir, 'dangling-link');
      await fs.symlink(safePath.join(tempDir, 'no-such-target.txt'), dangling);
      const cache = new FsLookupCache();

      // `existsSync` follows the link, so a dangling one reads as absent. The
      // link-graph walker's classifier depends on exactly this: a target it
      // cannot read is `missing-target`, not a present file.
      expect(cache.probe(dangling)).toEqual({ exists: false, isDirectory: null });
    });

    it('keeps probe entries per instance, so a fresh run re-probes', async () => {
      const filePath = safePath.join(tempDir, 'later.txt');
      const firstRun = new FsLookupCache();
      expect(firstRun.probe(filePath).exists).toBe(false);

      await fs.writeFile(filePath, '');

      // Same instance: still the snapshot it took.
      expect(firstRun.probe(filePath).exists).toBe(false);
      expect(new FsLookupCache().probe(filePath).exists).toBe(true);
    });

    it('is instance-scoped, so a new instance never serves another run stale entries', async () => {
      const dirPath = safePath.join(tempDir, 'growing');
      await fs.mkdir(dirPath);
      await fs.writeFile(safePath.join(dirPath, 'first.txt'), '');

      const firstRun = new FsLookupCache();
      expect(await firstRun.readdir(dirPath)).toEqual(['first.txt']);

      await fs.writeFile(safePath.join(dirPath, 'second.txt'), '');

      // Same instance: still the snapshot it took (that is the point of a per-run cache).
      expect(await firstRun.readdir(dirPath)).toEqual(['first.txt']);
      // A fresh instance — what a new validation run constructs — sees the new state.
      const secondRun = new FsLookupCache();
      expect((await secondRun.readdir(dirPath))?.length).toBe(2);
    });
  });

  describe('classifyFilenameCase', () => {
    // Pure — not one filesystem call in this block. Hand-written listings are the
    // only way to control entry ORDER, and order is exactly what this function
    // promises: see the exact-match-wins case below.
    const CASES: ReadonlyArray<{
      label: string;
      row: SiblingNames;
      expected: { exists: boolean; actualName: string | null };
    }> = [
      {
        label: 'an unreadable parent as absent with no name to suggest',
        row: { expectedName: 'README.md', names: null },
        expected: { exists: false, actualName: null },
      },
      {
        // Deliberately the same verdict as the `null` row above: the judge
        // collapses "unreadable directory" and "readable but empty" into one
        // answer. This row pins that collapse rather than a distinction — the
        // distinction survives only in the row, for a future judge that wants it.
        label: 'an empty listing the same way as an unreadable one',
        row: { expectedName: 'README.md', names: [] },
        expected: { exists: false, actualName: null },
      },
      {
        // `''` is falsy, so a truthiness test on the exact match would fall
        // through to the case-insensitive branch and return `actualName: ''`.
        // Unreachable from `readdir`, reachable from a hand-written row — which
        // is this function's advertised input now that it is pure.
        label: 'an empty basename against an empty entry as an exact match',
        row: { expectedName: '', names: [''] },
        expected: { exists: true, actualName: '' },
      },
      {
        label: 'an exact match as present',
        row: { expectedName: 'README.md', names: ['README.md'] },
        expected: { exists: true, actualName: 'README.md' },
      },
      {
        label: 'a case-only mismatch as absent, naming the entry that is really there',
        row: { expectedName: 'readme.md', names: ['README.md'] },
        expected: { exists: false, actualName: 'README.md' },
      },
      {
        label: 'an unrelated listing as absent with no name',
        row: { expectedName: 'README.md', names: ['CHANGELOG.md'] },
        expected: { exists: false, actualName: null },
      },
    ];

    it.each(CASES)('classifies $label', ({ row, expected }) => {
      expect(classifyFilenameCase(row)).toEqual(expected);
    });

    it('lets the exact match win even when a differently-cased entry comes first', () => {
      // The one input no filesystem hands you on demand, and the only one that
      // can see this refactor's relocated boundary: every single-entry case
      // above still passes with the two branches reversed, this one does not.
      expect(
        classifyFilenameCase({ expectedName: 'README.md', names: ['readme.md', 'README.md'] })
      ).toEqual({ exists: true, actualName: 'README.md' });
    });
  });

  describe('readSiblingNames', () => {
    it('fills the row from the parent directory listing', async () => {
      const filePath = safePath.join(tempDir, 'Row.txt');
      await fs.writeFile(filePath, '');

      const row = await readSiblingNames(filePath, new FsLookupCache());

      expect(row.expectedName).toBe('Row.txt');
      expect(row.names).toContain('Row.txt');
    });

    it('records an unreadable parent as a null listing, never as an empty one', async () => {
      const filePath = safePath.join(tempDir, 'no-such-dir', 'Row.txt');

      const row = await readSiblingNames(filePath, new FsLookupCache());

      expect(row).toEqual({ expectedName: 'Row.txt', names: null });
    });
  });

  describe('verifyCaseSensitiveFilename', () => {
    const TEST_FILE = 'TestFile.txt';

    it('reads the parent directory once for every link that shares a cache', async () => {
      const names = ['One.txt', 'Two.txt', 'Three.txt'];
      for (const name of names) {
        await fs.writeFile(safePath.join(tempDir, name), '');
      }
      const cache = new FsLookupCache();
      const spy = vi.spyOn(fs, 'readdir');

      const results = await Promise.all(
        names.map((name) => verifyCaseSensitiveFilename(safePath.join(tempDir, name), cache)),
      );

      expect(results.every((r) => r.exists)).toBe(true);
      // The regression this cache exists for: one uncached readdir per link.
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    });

    it('should return exists=true for exact case match', async () => {
      // Setup
      const filePath = safePath.join(tempDir, TEST_FILE);
      await fs.writeFile(filePath, 'content');

      // Execute
      const result = await verifyCaseSensitiveFilename(filePath, new FsLookupCache());

      // Verify
      expect(result.exists).toBe(true);
      expect(result.actualName).toBe(TEST_FILE);
    });

    it('should return exists=false for case mismatch', async () => {
      // Setup
      const actualPath = safePath.join(tempDir, TEST_FILE);
      const wrongCasePath = safePath.join(tempDir, 'testfile.txt');
      await fs.writeFile(actualPath, 'content');

      // Execute
      const result = await verifyCaseSensitiveFilename(wrongCasePath, new FsLookupCache());

      // Verify
      // On case-insensitive filesystems, the file will be found
      // but case won't match
      expect(result.exists).toBe(false);
      expect(result.actualName).toBe(TEST_FILE);
    });

    it('should return exists=false and null actualName for missing file', async () => {
      // Setup
      const filePath = safePath.join(tempDir, 'NonExistent.txt');

      // Execute
      const result = await verifyCaseSensitiveFilename(filePath, new FsLookupCache());

      // Verify
      expect(result.exists).toBe(false);
      expect(result.actualName).toBe(null);
    });

    it('should handle files in subdirectories with exact case', async () => {
      // Setup
      const subDir = safePath.join(tempDir, 'SubDir');
      await fs.mkdir(subDir);
      const filePath = safePath.join(subDir, 'File.txt');
      await fs.writeFile(filePath, 'content');

      // Execute
      const result = await verifyCaseSensitiveFilename(filePath, new FsLookupCache());

      // Verify
      expect(result.exists).toBe(true);
      expect(result.actualName).toBe('File.txt');
    });

    it('should detect case mismatch in subdirectory filename', async () => {
      // Setup
      const subDir = safePath.join(tempDir, 'SubDir');
      await fs.mkdir(subDir);
      const actualPath = safePath.join(subDir, 'File.txt');
      const wrongCasePath = safePath.join(subDir, 'file.txt');
      await fs.writeFile(actualPath, 'content');

      // Execute
      const result = await verifyCaseSensitiveFilename(wrongCasePath, new FsLookupCache());

      // Verify
      expect(result.exists).toBe(false);
      expect(result.actualName).toBe('File.txt');
    });
  });
});
