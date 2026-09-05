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
  fillRealpaths,
  fillSiblingNames,
  FsLookupCache,
  realpathFrom,
  siblingNamesFrom,
} from '../src/fs-utils.js';
import type {
  FilenameCaseVerdict,
  RealpathTable,
  SiblingNames,
  SiblingNamesTable,
} from '../src/fs-utils.js';
import { toForwardSlash } from '../src/path-core.js';
import type { SymlinkCapability } from '../src/test-helpers.js';
import { createSymlinkAsync, setupAsyncTempDirSuite, symlinkCapability } from '../src/test-helpers.js';

import { setupNestedDirectory } from './test-helpers.js';

/**
 * The enumerated-vs-derived path class (docs/architecture/resource-scanning-and-caching.md §3.6):
 * the same visible filename in two Unicode normalization forms.
 *
 * **The fixture is code-generated for a reason.** A file committed to git with an
 * accented name cannot be trusted to arrive decomposed: macOS editors and git
 * checkouts routinely re-normalize, so a committed fixture can silently be NFC on
 * both sides and pin nothing. Both forms are written as escape sequences so no
 * editor, formatter, or checkout can renormalize the literal out from under the
 * test.
 *
 * Module scope because TWO blocks need them now: the pure judge (hand-written
 * rows, where the fold-only verdict is decided) and the fill+judge pair over a
 * real directory (where the raw listing has to survive the fill to reach it).
 */
const NFD_NAME = 'cafe\u0301.txt';
const NFC_NAME = 'caf\u00E9.txt';

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

      expect(await cache.readdir(missing)).toBeNull();
      expect(await cache.readdir(missing)).toBeNull();

      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    });

    it('memoizes realpath and falls back to a resolved path when it fails', async () => {
      const cache = new FsLookupCache();
      // `nodeFs.realpath`, not `fs/promises.realpath`: the memo deliberately runs
      // Node's JS realpath so its answers match `fs.realpathSync` on a
      // case-insensitive filesystem. See the method's docblock.
      const spy = vi.spyOn(nodeFs, 'realpath');

      try {
        const real = await cache.realpath(tempDir);
        expect(await cache.realpath(tempDir)).toBe(real);
        expect(spy).toHaveBeenCalledTimes(1);

        const missing = safePath.join(tempDir, 'no-such-path');
        expect(await cache.realpath(missing)).toBe(safePath.resolve(missing));
      } finally {
        spy.mockRestore();
      }
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
      const cap = symlinkCapability() ?? skip();

      const dangling = safePath.join(tempDir, 'dangling-link');
      await createSymlinkAsync(cap, safePath.join(tempDir, 'no-such-target.txt'), dangling);
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

  describe('FsLookupCache.realpath — a path that cannot be canonicalized', () => {
    const GONE = 'gone.md';
    const DOCS = 'docs';

    /**
     * The only fixture shape that can tell the two candidate answers apart: a
     * root reached **through a symlink**.
     *
     * A temp dir taken from `normalizedTmpdir()` has already been realpath'd, so
     * asking about a missing file under it yields the same string either way —
     * lexical resolve and ancestor walk agree, and the assertion is vacuous.
     * That is precisely why nothing caught this. Here `link-root → real-root`
     * makes the lexical answer keep the `link-root` spelling while the walked
     * answer gains `real-root`, so every test below can state which one it got.
     *
     * `outside/` is a sibling of the root, reached from inside it by symlink:
     * the walk must not fabricate containment for paths that genuinely escape.
     */
    const setupSymlinkedRoot = async (
      base: string,
      skip: () => never,
    ): Promise<{
      cap: SymlinkCapability;
      realRoot: string;
      canonicalRealRoot: string;
      linkRoot: string;
      outside: string;
    }> => {
      // Handed back, not just used here: callers that add their own links must
      // thread this one probe's token rather than re-probing or — as two of
      // them did — naming a `cap` that only ever existed in this scope.
      const cap = symlinkCapability() ?? skip();
      const realRoot = safePath.join(base, 'real-root');
      const linkRoot = safePath.join(base, 'link-root');
      const outside = safePath.join(base, 'outside');
      await fs.mkdir(safePath.join(realRoot, DOCS), { recursive: true });
      await fs.mkdir(outside, { recursive: true });
      await createSymlinkAsync(cap, realRoot, linkRoot, 'dir');
      return {
        cap,
        realRoot,
        canonicalRealRoot: toForwardSlash(nodeFs.realpathSync(realRoot)),
        linkRoot,
        outside,
      };
    };

    it('answers a missing file in the namespace of its deepest existing ancestor', async ({
      skip,
    }) => {
      // Windows CI agents often lack the symlink privilege. Say so rather than
      // no-op: a silently skipped symlink case reads as a passing test.
      const { canonicalRealRoot, linkRoot } = await setupSymlinkedRoot(tempDir, skip);
      const missing = safePath.join(linkRoot, DOCS, GONE);

      const answer = await new FsLookupCache().realpath(missing);

      // Proof the fixture DISCRIMINATES before trusting the green: the two
      // candidate answers are different strings here, which they are not under a
      // temp dir that is already its own realpath.
      expect(safePath.resolve(missing)).not.toBe(safePath.join(canonicalRealRoot, DOCS, GONE));
      expect(answer).toBe(safePath.join(canonicalRealRoot, DOCS, GONE));
    });

    it('walks through several missing levels to reach the ancestor that exists', async ({
      skip,
    }) => {
      const { canonicalRealRoot, linkRoot } = await setupSymlinkedRoot(tempDir, skip);
      const missing = safePath.join(linkRoot, DOCS, 'nope', 'deeper', GONE);

      const answer = await new FsLookupCache().realpath(missing);

      // Every missing component is re-appended in order — a single-level walk
      // would answer the parent's canonical path, and a walk that dropped the
      // basename would lose components off the tail.
      expect(answer).toBe(safePath.join(canonicalRealRoot, DOCS, 'nope', 'deeper', GONE));
    });

    it('leaves an existing file byte-identical to realpathSync', async ({ skip }) => {
      const { linkRoot } = await setupSymlinkedRoot(tempDir, skip);
      const present = safePath.join(linkRoot, DOCS, 'here.md');
      await fs.writeFile(present, '');

      const answer = await new FsLookupCache().realpath(present);

      // The success path is untouched by the fallback change, and this column's
      // whole contract is equivalence with `fs.realpathSync` byte for byte.
      expect(answer).toBe(toForwardSlash(nodeFs.realpathSync(present)));
    });

    it('keeps an existing symlink that points outside the root resolving outside it', async ({
      skip,
    }) => {
      const { cap, canonicalRealRoot, realRoot, linkRoot, outside } = await setupSymlinkedRoot(tempDir, skip);
      const escapeTarget = safePath.join(outside, 'data.md');
      await fs.writeFile(escapeTarget, '');
      await createSymlinkAsync(cap, escapeTarget, safePath.join(realRoot, 'escape.md'));

      const answer = await new FsLookupCache().realpath(safePath.join(linkRoot, 'escape.md'));

      expect(answer).toBe(toForwardSlash(nodeFs.realpathSync(escapeTarget)));
      expect(answer.startsWith(canonicalRealRoot + '/')).toBe(false);
    });

    it('keeps a missing file behind an escaping directory symlink resolving outside the root', async ({
      skip,
    }) => {
      const { cap, canonicalRealRoot, realRoot, linkRoot, outside } = await setupSymlinkedRoot(tempDir, skip);
      await createSymlinkAsync(cap, outside, safePath.join(realRoot, 'outlink'), 'dir');
      const missing = safePath.join(linkRoot, 'outlink', GONE);

      const answer = await new FsLookupCache().realpath(missing);

      // The walk must widen nothing: canonicalizing through the deepest existing
      // ancestor is what makes an escape stay an escape, because the ancestor is
      // where the escaping link lives.
      expect(answer).toBe(safePath.join(toForwardSlash(nodeFs.realpathSync(outside)), GONE));
      expect(answer.startsWith(canonicalRealRoot + '/')).toBe(false);
    });

    it('stops at the filesystem root rather than recursing forever', async () => {
      // `path.dirname('/') === '/'` on posix and `path.win32.dirname('C:/') === 'C:/'`,
      // so without a fixpoint guard this call never returns and the test times out
      // instead of failing. Reaching the assertion at all is half the assertion.
      const fsRoot = toForwardSlash(path.parse(safePath.resolve(tempDir)).root);
      const orphan = 'vat-no-such-root-entry-9f3a';
      const missing = safePath.join(fsRoot, orphan);

      const answer = await new FsLookupCache().realpath(missing);

      expect(answer).toBe(safePath.join(toForwardSlash(nodeFs.realpathSync(fsRoot)), orphan));
    });
    it('terminates at the filesystem root when even the root cannot be canonicalized', async () => {
      // The fixpoint guard is UNREACHABLE through a real posix filesystem —
      // `realpath('/')` always succeeds, so the walk stops there for lack of a
      // failure, not for lack of a parent. It is reachable on Windows (a
      // nonexistent or disconnected drive root, `Z:/…`), which this branch has no
      // CI for. Forcing every canonicalization to fail reproduces that shape on
      // any platform: without the guard the walk asks the cache for the root's
      // own key, gets back the promise it is already inside, and deadlocks —
      // this test then dies by timeout rather than by assertion.
      const spy = vi
        .spyOn(nodeFs, 'realpath')
        .mockImplementation(((_target: string, callback: (error: Error) => void) => {
          // Not ENOENT: EACCES and ELOOP land in the same catch, and the walk is
          // deliberately errno-blind.
          callback(new Error('EACCES: permission denied'));
        }) as unknown as typeof nodeFs.realpath);
      const fsRoot = toForwardSlash(path.parse(safePath.resolve(tempDir)).root);
      const missing = safePath.join(fsRoot, 'a', 'b', 'c.md');

      const answer = await new FsLookupCache().realpath(missing);

      // Every level fell back, so the walk composes back to the lexical form —
      // which is the right answer precisely when nothing on the path resolves.
      expect(answer).toBe(missing);
      expect(spy.mock.calls.length).toBeGreaterThan(1);
      vi.restoreAllMocks();
    });

    it('shares one in-flight promise and canonicalizes the ancestor through the memo', async ({
      skip,
    }) => {
      const { linkRoot } = await setupSymlinkedRoot(tempDir, skip);
      const missing = safePath.join(linkRoot, DOCS, GONE);
      const cache = new FsLookupCache();
      const spy = vi.spyOn(nodeFs, 'realpath');

      // Asked twice with no `await` in between: the SAME promise object can only
      // come back if the row was stored before any await could run. A walk built
      // outside the already-stored promise would hand the second caller its own.
      const first = cache.realpath(missing);
      expect(cache.realpath(missing)).toBe(first);
      await first;

      // Two syscalls: the missing path (fails) and its parent (succeeds).
      expect(spy).toHaveBeenCalledTimes(2);
      // ...and the parent was canonicalized THROUGH this cache, so it is memoized.
      // A private recursive helper would answer identically and cost a third call.
      await cache.realpath(safePath.join(linkRoot, DOCS));
      expect(spy).toHaveBeenCalledTimes(2);
      vi.restoreAllMocks();
    });
  });

  describe('classifyFilenameCase', () => {
    // Pure — not one filesystem call in this block. Hand-written listings are the
    // only way to control entry ORDER, and order is exactly what this function
    // promises: see the exact-match-wins case below.
    const CASES: ReadonlyArray<{
      label: string;
      row: SiblingNames;
      expected: FilenameCaseVerdict;
    }> = [
      {
        label: 'an unreadable parent as absent with no name to suggest',
        row: { expectedName: 'README.md', names: null },
        expected: { exists: false, actualName: null, match: 'absent' },
      },
      {
        // Deliberately the same verdict as the `null` row above: the judge
        // collapses "unreadable directory" and "readable but empty" into one
        // answer. This row pins that collapse rather than a distinction — the
        // distinction survives only in the row, for a future judge that wants it.
        label: 'an empty listing the same way as an unreadable one',
        row: { expectedName: 'README.md', names: [] },
        expected: { exists: false, actualName: null, match: 'absent' },
      },
      {
        // `''` is falsy, so a truthiness test on the exact match would fall
        // through to the case-insensitive branch and return `actualName: ''`.
        // Unreachable from `readdir`, reachable from a hand-written row — which
        // is this function's advertised input now that it is pure.
        label: 'an empty basename against an empty entry as an exact match',
        row: { expectedName: '', names: [''] },
        expected: { exists: true, actualName: '', match: 'exact' },
      },
      {
        label: 'an exact match as present',
        row: { expectedName: 'README.md', names: ['README.md'] },
        expected: { exists: true, actualName: 'README.md', match: 'exact' },
      },
      {
        label: 'a case-only mismatch as absent, naming the entry that is really there',
        row: { expectedName: 'readme.md', names: ['README.md'] },
        expected: { exists: false, actualName: 'README.md', match: 'case_mismatch' },
      },
      {
        label: 'an unrelated listing as absent with no name',
        row: { expectedName: 'README.md', names: ['CHANGELOG.md'] },
        expected: { exists: false, actualName: null, match: 'absent' },
      },
      {
        // The one verdict that did not exist before: byte-different, equal only
        // after NFC folding. It stays `exists: true` (D7 — an accented file that
        // is really there must never be reported missing), but `match` separates
        // it from a byte-identical hit, because on a byte-exact filesystem
        // (Linux/ext4, and therefore CI and most deploy targets) opening the
        // asked-for spelling fails. `actualName` is the entry's own bytes, so a
        // caller can show the author what is actually on disk.
        label: 'a fold-only match as present but NOT byte-exact',
        row: { expectedName: NFC_NAME, names: [NFD_NAME] },
        expected: { exists: true, actualName: NFD_NAME, match: 'normalized' },
      },
      {
        // Both a case difference AND a normalization difference. Case-folding
        // alone cannot reconcile NFC/NFD, so the case-insensitive pass has to
        // fold first or this row reports `absent` and the author loses the hint.
        label: 'a case mismatch that also differs by normalization',
        row: { expectedName: NFC_NAME.toUpperCase(), names: [NFD_NAME] },
        expected: { exists: false, actualName: NFD_NAME, match: 'case_mismatch' },
      },
    ];

    it.each(CASES)('classifies $label', ({ row, expected }) => {
      expect(classifyFilenameCase(row)).toEqual(expected);
    });

    it('lets the byte-exact match win even when a fold-only candidate comes first', () => {
      // Entry order is the only thing separating these two, and no filesystem
      // hands you a chosen order. A judge that folded both sides before
      // comparing (the shape this replaced) cannot tell them apart at all: it
      // would answer `exact` for whichever entry `find` reached first.
      expect(
        classifyFilenameCase({ expectedName: NFC_NAME, names: [NFD_NAME, NFC_NAME] })
      ).toEqual({ exists: true, actualName: NFC_NAME, match: 'exact' });
    });

    it('lets the exact match win even when a differently-cased entry comes first', () => {
      // The one input no filesystem hands you on demand, and the only one that
      // can see this refactor's relocated boundary: every single-entry case
      // above still passes with the two branches reversed, this one does not.
      expect(
        classifyFilenameCase({ expectedName: 'README.md', names: ['readme.md', 'README.md'] })
      ).toEqual({ exists: true, actualName: 'README.md', match: 'exact' });
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

    /**
     * The enumerated-vs-derived path class over a real directory. The module-scope
     * fixture constants explain
     * why both forms are escape sequences; what this block adds is the round trip
     * through `readdir`.
     *
     * `readdir` hands back exactly the bytes written (APFS preserves the form),
     * so the on-disk entry is decomposed while the path being asked about is
     * composed — the shape a markdown link takes in practice.
     *
     * ⚠️ This must NOT be written as an `existsSync` test. macOS is
     * normalization-*insensitive* at the syscall level, so `existsSync` on the
     * composed form returns `true` even here and would report the bug as
     * absent. The comparison under test is string equality over the listing,
     * which behaves identically on every platform.
     *
     * ⚠️ **Both directions, deliberately.** Which side is decomposed decides
     * nothing about the verdict, and a one-directional case would leave that
     * unproven — the older shape folded the listing in the fill and the query in
     * the row lookup, so exactly one direction exercised each half.
     */
    const NORMALIZATION_PAIRS: readonly { label: string; onDisk: string; asked: string }[] = [
      { label: 'a composed query against a decomposed listing', onDisk: NFD_NAME, asked: NFC_NAME },
      { label: 'a decomposed query against a composed listing', onDisk: NFC_NAME, asked: NFD_NAME },
    ];

    it.each(NORMALIZATION_PAIRS)(
      'judges $label as present but fold-only, never byte-exact (D7)',
      async ({ onDisk, asked }) => {
        // Guard the premise twice: different as bytes, identical once folded. If
        // either ever stopped holding, the test would pass while demonstrating
        // nothing.
        expect(onDisk).not.toBe(asked);
        expect(onDisk.normalize('NFC')).toBe(asked.normalize('NFC'));

        await fs.writeFile(safePath.join(tempDir, onDisk), '');
        const askedPath = safePath.join(tempDir, asked);

        const table = await fillSiblingNames([askedPath], new FsLookupCache());

        // The fill no longer folds, so the entry's own bytes reach the judge.
        // Fold in the fill and this row goes red — and with it the only evidence
        // that could ever separate the two verdicts below.
        expect(siblingNamesFrom(table, askedPath).names).toContain(onDisk);

        // D7 still holds: an accented file that is really there is present, not
        // missing. What is new is the second field — the link resolves ONLY
        // because both sides were folded, so on ext4 (CI, and most deploy
        // targets) the asked-for spelling opens nothing.
        expect(classifyFilenameCaseFrom(table, askedPath)).toEqual({
          exists: true,
          actualName: onDisk,
          match: 'normalized',
        });
      }
    );

    it('judges a byte-identical accented name as exact, not as a fold (control)', async () => {
      // The negative control for the row above: same fixture, same code path,
      // and the ONE difference is that the link spells the file the way disk
      // does. Without it, `match: 'normalized'` could be what this judge answers
      // for every accented filename, and the warning it drives would fire on
      // files that are perfectly fine.
      await fs.writeFile(safePath.join(tempDir, NFC_NAME), '');
      const askedPath = safePath.join(tempDir, NFC_NAME);

      const table = await fillSiblingNames([askedPath], new FsLookupCache());

      expect(classifyFilenameCaseFrom(table, askedPath)).toEqual({
        exists: true,
        actualName: NFC_NAME,
        match: 'exact',
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
        match: 'exact',
      });
      expect(classifyFilenameCaseFrom(table, safePath.join(tempDir, 'judged.txt'))).toEqual({
        exists: false,
        actualName: JUDGED,
        match: 'case_mismatch',
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
    const judge = async (filePath: string): Promise<FilenameCaseVerdict> =>
      classifyFilenameCaseFrom(await fillSiblingNames([filePath], new FsLookupCache()), filePath);

    // Real listings, unlike the hand-written rows the pure judge is tested with
    // above: these pin that the fill derives the parent, and that the verdict
    // survives a `readdir` in whatever order the platform returns it.
    const CASES: ReadonlyArray<{
      label: string;
      /** Create the fixture under `dir`; returns the path to judge. */
      setup: (dir: string) => Promise<string>;
      expected: FilenameCaseVerdict;
    }> = [
      {
        label: 'an exact-case file as present',
        setup: async (dir) => {
          const filePath = safePath.join(dir, TEST_FILE);
          await fs.writeFile(filePath, 'content');
          return filePath;
        },
        expected: { exists: true, actualName: TEST_FILE, match: 'exact' },
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
        expected: { exists: false, actualName: TEST_FILE, match: 'case_mismatch' },
      },
      {
        // Distinct from the unreadable-parent case above: the directory lists
        // fine, the name is simply not in it, so there is nothing to suggest.
        label: 'a missing file in a readable directory as absent with no name to suggest',
        setup: (dir) => Promise.resolve(safePath.join(dir, 'NonExistent.txt')),
        expected: { exists: false, actualName: null, match: 'absent' },
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
        expected: { exists: true, actualName: 'File.txt', match: 'exact' },
      },
      {
        label: 'a case-only mismatch one directory down',
        setup: async (dir) => {
          const subDir = safePath.join(dir, 'SubDir');
          await fs.mkdir(subDir);
          await fs.writeFile(safePath.join(subDir, 'File.txt'), 'content');
          return safePath.join(subDir, 'file.txt');
        },
        expected: { exists: false, actualName: 'File.txt', match: 'case_mismatch' },
      },
    ];

    it.each(CASES)('reports $label', async ({ setup, expected }) => {
      expect(await judge(await setup(tempDir))).toEqual(expected);
    });
  });

  describe('fillRealpaths + realpathFrom', () => {
    const PURE = 'Pure.txt';

    /**
     * Instrument BOTH canonicalization routes, on the same `node:fs` default
     * object `fs-utils.ts` imports: the callback `realpath` (how the fill reaches
     * disk, via `promisify`) and `realpathSync` (how a regressed judge would).
     *
     * Spying the default object rather than named bindings is what makes the
     * counts real. `vi.spyOn` cannot intercept a NAMED ESM import of a builtin —
     * Node snapshots those bindings at import time, so such a spy attaches and
     * counts zero, which reads exactly like "this performs no I/O". The same trap
     * catches a `promisify` hoisted to module scope: it would capture the function
     * before any spy could replace it.
     */
    const spyRealpathRoutes = (): { counts: () => number[]; clear: () => void } => {
      const spies = [vi.spyOn(nodeFs, 'realpath'), vi.spyOn(nodeFs, 'realpathSync')];
      return {
        counts: (): number[] => spies.map((spy) => spy.mock.calls.length),
        clear: (): void => {
          for (const spy of spies) spy.mockClear();
        },
      };
    };

    it('fills one row per distinct path, keyed by the input string exactly', async () => {
      const names = ['Alpha.txt', 'Beta.txt'];
      const filePaths = names.map((name) => safePath.join(tempDir, name));
      await Promise.all(filePaths.map((filePath) => fs.writeFile(filePath, '')));

      const table = await fillRealpaths(filePaths, new FsLookupCache());

      // Keyed by the INPUT string, not a dirname and not a re-resolved form: the
      // judge looks up by that same string, and any normalization here would be
      // a miss — which throws.
      const byName = (a: string, b: string): number => a.localeCompare(b);
      expect([...table.keys()].sort(byName)).toEqual([...filePaths].sort(byName));
      expect(
        names.every((name, i) => realpathFrom(table, filePaths[i] ?? '').endsWith(name))
      ).toBe(true);
    });

    it('canonicalizes one distinct path once however many times it is passed', async () => {
      const filePath = safePath.join(tempDir, 'Repeated.txt');
      await fs.writeFile(filePath, '');
      const cache = new FsLookupCache();
      const syscall = vi.spyOn(nodeFs, 'realpath');
      // TWO levels are instrumented, because only one of them can see the
      // de-duplication. `FsLookupCache.realpath` memoizes, so the SYSCALL count
      // is 1 whether or not the fill de-dupes — measured: dropping the `Set`
      // leaves `nodeFs.realpath` at exactly 1 and this test green. The cache-level
      // spy is the one that dies with the de-duplication.
      const deduped = vi.spyOn(cache, 'realpath');

      const table = await fillRealpaths([filePath, filePath, filePath], cache);

      // A count of exactly one is also the positive control — an instrument that
      // never attached counts zero — and the recorded argument pins that what it
      // counted is THIS path's canonicalization, not an incidental syscall from
      // somewhere else in the run.
      expect(syscall).toHaveBeenCalledTimes(1);
      // First argument only: this is the CALLBACK form, so the recorded call also
      // carries the continuation `promisify` supplies.
      expect(syscall.mock.calls[0]?.[0]).toBe(filePath);
      expect(deduped).toHaveBeenCalledTimes(1);
      expect(table.size).toBe(1);
      vi.restoreAllMocks();
    });

    it('gives an absent path a row too — the resolved-path fallback, not a throw', async () => {
      const missing = safePath.join(tempDir, 'no-such-file.txt');

      const table = await fillRealpaths([missing], new FsLookupCache());

      // The fallback IS the contract: a non-existent path has no realpath, and a
      // caller comparing paths still needs an answer. So a filled row is always a
      // string, which is what lets `undefined` mean "absent key" and nothing else.
      expect(realpathFrom(table, missing)).toBe(safePath.resolve(missing));
    });

    it('throws from realpathFrom when the table holds no row for the path', () => {
      const unfilled = safePath.join(tempDir, 'Unkeyed.txt');
      const empty: RealpathTable = new Map();

      // Degrading to a recomputed realpath would silently reinstate the per-path
      // syscall this column exists to remove, and no test of the VERDICT would
      // catch it. The miss is a programming error, so it is loud — and it names
      // the remedy.
      expect(() => realpathFrom(empty, unfilled)).toThrow(unfilled);
      expect(() => realpathFrom(empty, unfilled)).toThrow('fillRealpaths');
    });

    it('judges from a filled table, reaching neither the async nor the sync realpath', async () => {
      const filePath = safePath.join(tempDir, PURE);
      await fs.writeFile(filePath, '');
      const routes = spyRealpathRoutes();

      const table = await fillRealpaths([filePath], new FsLookupCache());
      // Positive control for the sync route. `fs-utils.ts` has no production
      // `realpathSync` caller today — this guard exists so that one cannot be
      // ADDED at judgement time — so the control drives the same module-default
      // object such a judge would reach. Without it the zero below is
      // indistinguishable from an instrument that never attached at all.
      nodeFs.realpathSync(tempDir);

      expect(routes.counts().every((n) => n > 0)).toBe(true);
      routes.clear();

      expect(realpathFrom(table, filePath).endsWith(PURE)).toBe(true);
      expect(routes.counts()).toEqual([0, 0]);
      vi.restoreAllMocks();
    });

    it('yields an empty table for no paths, without touching the filesystem', async () => {
      // Both spies come from the helper the purity case above proves attaches,
      // so these zeros are absence of calls rather than absence of instruments.
      const routes = spyRealpathRoutes();

      const table = await fillRealpaths([], new FsLookupCache());

      expect(table.size).toBe(0);
      expect(routes.counts()).toEqual([0, 0]);
      vi.restoreAllMocks();
    });

    it('resolves a symlink to its target, filed under the link path asked about', async ({
      skip,
    }) => {
      // Windows CI agents often lack the symlink privilege. Say so rather than
      // no-op: a silently skipped symlink case reads as a passing test.
      const cap = symlinkCapability() ?? skip();

      const targetPath = safePath.join(tempDir, 'Target.txt');
      const linkPath = safePath.join(tempDir, 'Link.txt');
      await fs.writeFile(targetPath, '');
      await createSymlinkAsync(cap, targetPath, linkPath);

      const table = await fillRealpaths([linkPath], new FsLookupCache());

      // The row is the TARGET's canonical path filed under the LINK's path,
      // which is what makes this column a canonicalization rather than an echo.
      expect(realpathFrom(table, linkPath)).toBe(toForwardSlash(nodeFs.realpathSync(targetPath)));
      expect(realpathFrom(table, linkPath)).not.toBe(safePath.resolve(linkPath));
    });

    it('answers a mis-cased path exactly as realpathSync does, not as the native resolver does', async ({
      skip,
    }) => {
      const dirOnDisk = safePath.join(tempDir, 'CaseSub');
      await fs.mkdir(dirOnDisk);
      await fs.writeFile(safePath.join(dirOnDisk, 'Target.TXT'), '');
      // BOTH components are mis-cased on purpose. The two realpath
      // implementations differ on DIRECTORY components as well as on the
      // basename, so a basename-only fixture under-tests the divergence.
      const misCased = safePath.join(tempDir, 'casesub', 'target.txt');

      // Probe the FIXTURE, never `process.platform`. On a case-sensitive
      // filesystem (typical Linux CI) the mis-cased path does not exist at all:
      // both routes fail identically, fall back to the resolved path, and the
      // assertion below is vacuous — a pass that proves nothing. Skipping says so
      // out loud. macOS and Windows are where this case has teeth, and they are
      // exactly the two platforms this branch has no CI for.
      if (!nodeFs.existsSync(misCased)) skip();

      const table = await fillRealpaths([misCased], new FsLookupCache());

      // Pinned to what `fs.realpathSync` answers for the SAME input rather than
      // to a literal string: the contract is equivalence with the synchronous
      // route that the synchronous callers this column replaced use. Anything
      // else changes findings on a case-insensitive filesystem.
      expect(realpathFrom(table, misCased)).toBe(toForwardSlash(nodeFs.realpathSync(misCased)));
    });

    it('answers the empty path as realpathSync does, where the native resolver throws', async () => {
      // The fifth input class from the divergence survey: `fs.realpathSync('')`
      // resolves to the cwd, while `fs/promises.realpath('')` throws ENOENT
      // (measured, Node v24.13.1 / darwin). This one is a CONTRACT PIN, not a
      // discriminator — the ENOENT lands in the `safePath.resolve()` fallback,
      // which also answers the cwd, so the two routes agree here whenever the cwd
      // is itself a real path. It is kept because that agreement is incidental:
      // pinning to the sync route stops a future fallback change drifting it.
      const table = await fillRealpaths([''], new FsLookupCache());

      expect(realpathFrom(table, '')).toBe(toForwardSlash(nodeFs.realpathSync('')));
    });

    it('routes canonicalization through the node:fs default object, so a post-load spy sees it', async () => {
      // The shape guard for `FsLookupCache.realpath`. Promisifying at module
      // scope would capture `nodeFs.realpath` eagerly and bypass every spy
      // installed after import — the memo would still answer correctly and this
      // counter would read zero, which is indistinguishable from "performs no
      // I/O". Same failure mode the file-header comment describes for named ESM
      // imports, reached by a different route.
      const filePath = safePath.join(tempDir, 'Spied.txt');
      await fs.writeFile(filePath, '');
      const spy = vi.spyOn(nodeFs, 'realpath');

      const answer = await new FsLookupCache().realpath(filePath);

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]?.[0]).toBe(filePath);
      // The spy must not have swallowed the answer: an instrument that broke the
      // call would also count 1.
      expect(answer).toBe(toForwardSlash(nodeFs.realpathSync(filePath)));
      vi.restoreAllMocks();
    });
  });
});
