/* eslint-disable security/detect-non-literal-fs-filename -- Test code using temp directories */
import nodeFs from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  classifyFilenameCase,
  classifyFilenameCaseFrom,
  copyDirectory,
  fillSiblingNames,
  FsLookupCache,
  siblingNamesFrom,
} from '../src/fs-utils.js';
import type { SiblingNames, SiblingNamesTable } from '../src/fs-utils.js';
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

  describe('fillSiblingNames', () => {
    const SIBLINGS = ['One.txt', 'Two.txt', 'Three.txt'];

    /** Create `SIBLINGS` as empty files in `dir`; returns their paths. */
    const writeSiblings = async (dir: string): Promise<string[]> => {
      const filePaths = SIBLINGS.map((name) => safePath.join(dir, name));
      await Promise.all(filePaths.map((filePath) => fs.writeFile(filePath, '')));
      return filePaths;
    };

    it('fills a row for each file from its parent directory listing', async () => {
      const filePath = safePath.join(tempDir, 'Row.txt');
      await fs.writeFile(filePath, '');

      const table = await fillSiblingNames([filePath], new FsLookupCache());
      const row = siblingNamesFrom(table, filePath);

      expect(row.expectedName).toBe('Row.txt');
      expect(row.names).toContain('Row.txt');
    });

    it('records an unreadable parent as a null listing, never as an empty one', async () => {
      const filePath = safePath.join(tempDir, 'no-such-dir', 'Row.txt');

      const table = await fillSiblingNames([filePath], new FsLookupCache());

      expect(siblingNamesFrom(table, filePath)).toEqual({
        expectedName: 'Row.txt',
        names: null,
      });
    });

    it('lists a directory ONCE however many of its files are asked about', async () => {
      const filePaths = await writeSiblings(tempDir);
      const cache = new FsLookupCache();
      const spy = vi.spyOn(cache, 'readdir');

      const table = await fillSiblingNames(filePaths, cache);

      // The one assertion that dies when the de-duplication dies: every
      // assertion about the VALUES still passes when each file lists its own
      // parent again, because the answers are identical — only slower.
      expect(spy).toHaveBeenCalledTimes(1);
      expect(table.size).toBe(1);
      expect(filePaths.every((p) => siblingNamesFrom(table, p).names?.length === 3)).toBe(
        true
      );
      spy.mockRestore();
    });

    it('issues the listings for distinct directories concurrently', async () => {
      const dirs = ['d1', 'd2', 'd3'].map((name) => safePath.join(tempDir, name));
      await Promise.all(dirs.map((dir) => fs.mkdir(dir)));
      const filePaths = dirs.map((dir) => safePath.join(dir, 'f.txt'));

      const cache = new FsLookupCache();
      const realReaddir = cache.readdir.bind(cache);
      let started = 0;
      let release = (): void => {};
      const allStarted = new Promise<void>((resolve) => {
        release = resolve;
      });
      // A serial fill awaits each listing before starting the next, so the
      // third start never happens and only this timer would free the barrier.
      let serialized = false;
      const escape = setTimeout(() => {
        serialized = true;
        release();
      }, 500);

      vi.spyOn(cache, 'readdir').mockImplementation(async (dirPath: string) => {
        started += 1;
        if (started === dirs.length) release();
        await allStarted;
        return realReaddir(dirPath);
      });

      const table = await fillSiblingNames(filePaths, cache);
      clearTimeout(escape);

      expect(serialized).toBe(false);
      expect(table.size).toBe(3);
      vi.restoreAllMocks();
    });

    it('yields an empty table for no files, without touching the filesystem', async () => {
      const spy = vi.spyOn(fs, 'readdir');

      const table = await fillSiblingNames([], new FsLookupCache());

      expect(table.size).toBe(0);
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  describe('classifyFilenameCaseFrom', () => {
    const JUDGED = 'Judged.txt';

    it('judges from a filled table, reaching neither readdir nor the sync stat pair', async () => {
      const filePath = safePath.join(tempDir, JUDGED);
      await fs.writeFile(filePath, '');
      // THREE routes are instrumented, not one. `readdir` is how the fill
      // reaches disk — but `existsSync` and `statSync` are already imported at
      // the top of `fs-utils.ts` (for `FsLookupCache.probe`), so a judge that
      // started stat-ing its target is one keystroke away, and a readdir-only
      // spy stays green straight through that regression. Spying the default
      // objects, not namespace bindings, is what makes the counts real.
      const spies = [
        vi.spyOn(fs, 'readdir'),
        vi.spyOn(nodeFs, 'existsSync'),
        vi.spyOn(nodeFs, 'statSync'),
      ];
      const counts = (): number[] => spies.map((spy) => spy.mock.calls.length);

      const table = await fillSiblingNames([filePath], new FsLookupCache());
      // Positive control for the sync pair: `probe` takes exactly the route a
      // regressed judge would take, through the same two module-level imports.
      // Without it, the zeros below are indistinguishable from instruments that
      // never attached to the functions under test.
      new FsLookupCache().probe(filePath);

      expect(counts().every((n) => n > 0)).toBe(true);
      const beforeJudging = counts();

      expect(classifyFilenameCaseFrom(table, filePath)).toEqual({
        exists: true,
        actualName: JUDGED,
      });
      expect(classifyFilenameCaseFrom(table, safePath.join(tempDir, 'judged.txt'))).toEqual({
        exists: false,
        actualName: JUDGED,
      });

      expect(counts()).toEqual(beforeJudging);
      vi.restoreAllMocks();
    });

    it('throws when the table has no row for the file’s parent directory', () => {
      const filePath = safePath.join(tempDir, 'Unfilled.txt');
      const empty: SiblingNamesTable = new Map();

      // A `names: null` fallback would report every file under the unfilled
      // directory as MISSING — a wrong answer wearing the shape of a graceful
      // degradation. The miss is a programming error, so it is loud.
      expect(() => classifyFilenameCaseFrom(empty, filePath)).toThrow(path.dirname(filePath));
      expect(() => classifyFilenameCaseFrom(empty, filePath)).toThrow('Unfilled.txt');
    });
  });

  describe('fill + judge over a real filesystem', () => {
    const TEST_FILE = 'TestFile.txt';

    it('reads the parent directory once across separate fills that share a cache', async () => {
      const names = ['One.txt', 'Two.txt', 'Three.txt'];
      for (const name of names) {
        await fs.writeFile(safePath.join(tempDir, name), '');
      }
      const cache = new FsLookupCache();
      const spy = vi.spyOn(fs, 'readdir');

      // Deliberately three separate fills rather than one fill over three paths.
      // De-duplication *within* a fill is pinned above; what this pins is the
      // sharing `fillSiblingNames` promises ACROSS fills, which is the shape a
      // real run has (frontmatter links, then body links, then the next file).
      const tables = await Promise.all(
        names.map((name) => fillSiblingNames([safePath.join(tempDir, name)], cache))
      );

      expect(
        tables.every((table, i) =>
          classifyFilenameCaseFrom(table, safePath.join(tempDir, names[i] ?? '')).exists
        )
      ).toBe(true);
      // The regression the cache exists for: one uncached readdir per fill.
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    });

    /**
     * Fill for one path and judge it.
     *
     * The one-path composition is fine *here* and wrong in production: these
     * cases each set up their own fixture, so there is no set to fill over. A
     * caller with many paths that loops over this shape is the serialized
     * `readdir` the pair exists to remove.
     */
    const judge = async (filePath: string): Promise<{ exists: boolean; actualName: string | null }> =>
      classifyFilenameCaseFrom(await fillSiblingNames([filePath], new FsLookupCache()), filePath);

    // Real listings, unlike the hand-written rows the pure judge is tested with
    // above: these pin that the fill derives the parent, and that the verdict
    // survives a `readdir` in whatever order the platform returns it.
    const CASES: ReadonlyArray<{
      label: string;
      /** Create the fixture under `dir`; returns the path to judge. */
      setup: (dir: string) => Promise<string>;
      expected: { exists: boolean; actualName: string | null };
    }> = [
      {
        label: 'an exact-case file as present',
        setup: async (dir) => {
          const filePath = safePath.join(dir, TEST_FILE);
          await fs.writeFile(filePath, 'content');
          return filePath;
        },
        expected: { exists: true, actualName: TEST_FILE },
      },
      {
        // Holds on both kinds of filesystem, for different reasons: a
        // case-insensitive one finds the file under the wrong case, a
        // case-sensitive one does not find it at all — and the case-insensitive
        // second pass names the entry really on disk either way.
        label: 'a case-only mismatch as absent, naming the entry really on disk',
        setup: async (dir) => {
          await fs.writeFile(safePath.join(dir, TEST_FILE), 'content');
          return safePath.join(dir, 'testfile.txt');
        },
        expected: { exists: false, actualName: TEST_FILE },
      },
      {
        // Distinct from the unreadable-parent case above: the directory lists
        // fine, the name is simply not in it, so there is nothing to suggest.
        label: 'a missing file in a readable directory as absent with no name to suggest',
        setup: (dir) => Promise.resolve(safePath.join(dir, 'NonExistent.txt')),
        expected: { exists: false, actualName: null },
      },
      {
        // Nested, so the fill's own `path.dirname` derivation is what has to
        // find the listing — not the temp root every other case shares.
        label: 'an exact-case file one directory down as present',
        setup: async (dir) => {
          const subDir = safePath.join(dir, 'SubDir');
          await fs.mkdir(subDir);
          const filePath = safePath.join(subDir, 'File.txt');
          await fs.writeFile(filePath, 'content');
          return filePath;
        },
        expected: { exists: true, actualName: 'File.txt' },
      },
      {
        label: 'a case-only mismatch one directory down',
        setup: async (dir) => {
          const subDir = safePath.join(dir, 'SubDir');
          await fs.mkdir(subDir);
          await fs.writeFile(safePath.join(subDir, 'File.txt'), 'content');
          return safePath.join(subDir, 'file.txt');
        },
        expected: { exists: false, actualName: 'File.txt' },
      },
    ];

    it.each(CASES)('reports $label', async ({ setup, expected }) => {
      expect(await judge(await setup(tempDir))).toEqual(expected);
    });
  });
});
