/* eslint-disable security/detect-non-literal-fs-filename -- Test code using temp directories */
import nodeFs from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  copyDirectory,
  DirectorySpellingIndex,
  fillPathSpellings,
  fillRealpaths,
  FsLookupCache,
  pathSpellingFrom,
  realpathFrom,
  spellingWalkRoot,
} from '../src/fs-utils.js';
import type { DirectoryListing, RealpathTable } from '../src/fs-utils.js';
import { toForwardSlash } from '../src/path-core.js';
import type { SymlinkCapability } from '../src/test-helpers.js';
import { createSymlinkAsync, setupAsyncTempDirSuite, symlinkCapability } from '../src/test-helpers.js';

import { setupNestedDirectory } from './test-helpers.js';

/** A directory name no fixture plants, so listing it always fails. */
const NO_SUCH_DIR = 'no-such-dir';

/** A name to ask a directory about, where WHICH name is beside the point. */
const ANY_NAME = 'anything.md';

/** The path `plantDeep` plants, spelled as a `pathSpellingFrom` correction is. */
const PLANTED_PATH = 'one/two/three.md';

/**
 * Whether a POSIX mode actually binds this process.
 *
 * Windows does not enforce mode bits, and **root ignores them** — a root
 * process lists a `--x` directory happily, which would make every assertion
 * below pass against the very bug they exist to catch. Both halves are the
 * guard; skipping only on Windows leaves the test vacuous where CI runs as root.
 */
const PERMISSIONS_ENFORCED = process.platform !== 'win32' && process.getuid?.() !== 0;

/**
 * Owner `--x`: traversable, so a file below still opens — and NOT listable.
 * Only the owner bits are set, which is all this process's own access depends
 * on, and the restore below is the matching owner-only `rwx`.
 */
const MODE_TRAVERSE_ONLY = 0o100;
const MODE_RWX_OWNER = 0o700;

/** The names out of a listing, failing loudly rather than reading a non-listing. */
function namesOf(listing: DirectoryListing): readonly string[] {
  if (listing.outcome !== 'listed') {
    throw new Error(`Expected a listed directory, got "${listing.outcome}".`);
  }
  return listing.names;
}

/**
 * Run `body` with `dir` traversable but unlistable, restoring the mode after.
 *
 * ⚠️ The `finally` is not tidiness: a directory left `--x` cannot be removed,
 * so the temp-dir teardown fails and poisons every later test in the file.
 */
async function withUnlistableDirectory<T>(dir: string, body: () => Promise<T>): Promise<T> {
  await fs.chmod(dir, MODE_TRAVERSE_ONLY);
  try {
    return await body();
  } finally {
    await fs.chmod(dir, MODE_RWX_OWNER);
  }
}

/** Plant `one/two/three.md` under `dir`, beside a referring `a.md`. */
async function plantDeep(dir: string): Promise<string> {
  await fs.mkdir(safePath.join(dir, 'one', 'two'), { recursive: true });
  await fs.writeFile(safePath.join(dir, 'one', 'two', 'three.md'), '');
  await fs.writeFile(safePath.join(dir, 'a.md'), '');
  return dir;
}

/**
 * The errnos a refused `readdir` arrives as, split by whether re-asking can
 * answer differently.
 *
 * ⚠️ **The split IS the contract under test, not a taxonomy.** `EACCES` (a mode
 * bit) and `ELOOP` (a committed symlink cycle) are facts about the tree that
 * hold for the whole run, so memoizing them is exactly what the cache is for.
 * `EMFILE`/`ENFILE` are a *moment* — the process ran out of descriptors — and a
 * memo that keeps one turns a blip into a run-long verdict about every path
 * under that directory, at exit 0, that a re-run does not reproduce.
 */
const STABLE_REFUSALS = ['EACCES', 'ELOOP'] as const;
const TRANSIENT_REFUSALS = ['EMFILE', 'ENFILE'] as const;
const ALL_REFUSALS = [...STABLE_REFUSALS, ...TRANSIENT_REFUSALS];

/** A rejection shaped like the one `fs.readdir` throws for `code`. */
function refusal(code: string): Error {
  return Object.assign(new Error(`${code}: refused, scandir`), { code });
}

/**
 * Run `body` with exactly the NEXT `readdir` refused with `code`.
 *
 * `vi.spyOn` calls through once the one-shot rejection is consumed, so what the
 * run sees is a single refused syscall inside an otherwise ordinary tree —
 * which is what a transient shortage looks like, and the only shape that can
 * tell a dropped memo from a kept one. A mock that refused *every* call would
 * pass whether the failure is memoized or not.
 *
 * @param code - The errno to refuse the next listing with
 * @param body - Runs while the refusal is armed
 * @returns What `body` returned, plus how many listings actually happened
 */
async function withReaddirRefusedOnce<T>(
  code: string,
  body: () => Promise<T>,
): Promise<{ result: T; readdirCalls: number }> {
  const spy = vi.spyOn(fs, 'readdir').mockRejectedValueOnce(refusal(code));
  try {
    return { result: await body(), readdirCalls: spy.mock.calls.length };
  } finally {
    spy.mockRestore();
  }
}

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

    it('caches the missing-directory answer without re-spawning the syscall', async () => {
      const cache = new FsLookupCache();
      const missing = safePath.join(tempDir, NO_SUCH_DIR);
      const spy = vi.spyOn(fs, 'readdir');

      expect(await cache.readdir(missing)).toEqual({ outcome: 'absent' });
      expect(await cache.readdir(missing)).toEqual({ outcome: 'absent' });

      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    });

    /**
     * 🪤 The conflation this pins: one `null` used to mean both *"there is no
     * such directory"* and *"I was refused"*. Only the first may read as
     * absence — a caller that judges a path component by component turns the
     * second into a confident "this file does not exist" about a file that
     * opens fine, because `--x` is traversable and only `readdir` is refused.
     */
    it.skipIf(!PERMISSIONS_ENFORCED)(
      'reports a directory it may traverse but not list as unreadable, not absent',
      async () => {
        const closed = safePath.join(tempDir, 'closed');
        await fs.mkdir(closed, { recursive: true });
        await fs.writeFile(safePath.join(closed, 'inside.md'), '');
        const cache = new FsLookupCache();

        const listing = await withUnlistableDirectory(
          closed,
          async () => await cache.readdir(closed),
        );

        expect(listing).toEqual({ outcome: 'unreadable', code: 'EACCES' });
      },
    );

    /**
     * 🪤 **The memo was right for one kind of refusal and wrong for the other,
     * and it could not tell them apart.** Caching a failed listing is correct
     * for `EACCES`/`ELOOP` — nothing about the tree will change mid-run — and
     * wrong for `EMFILE`/`ENFILE`, where the process merely ran out of
     * descriptors for an instant. One blip un-verified every path under that
     * directory for the REST OF THE RUN, producing a burst of findings that a
     * re-run does not reproduce. Not silent any more, but still fabricated.
     */
    describe('a refused listing is remembered only when re-asking cannot help', () => {
      it.each(STABLE_REFUSALS)(
        'memoizes a %s refusal, because a stable denial is a fact about the tree',
        async (code) => {
          const cache = new FsLookupCache();

          const { result, readdirCalls } = await withReaddirRefusedOnce(code, async () => ({
            first: await cache.readdir(tempDir),
            second: await cache.readdir(tempDir),
          }));

          expect(result.first).toEqual({ outcome: 'unreadable', code });
          expect(result.second).toEqual({ outcome: 'unreadable', code });
          // One syscall for two asks. This is the assertion that dies if the fix
          // over-corrects into "never cache a failure", which would re-issue a
          // refused listing per caller for every path under a `--x` directory.
          expect(readdirCalls).toBe(1);
        },
      );

      it.each(TRANSIENT_REFUSALS)(
        'does NOT memoize a %s refusal, because a descriptor shortage is a moment',
        async (code) => {
          await fs.writeFile(safePath.join(tempDir, 'a.txt'), '');
          const cache = new FsLookupCache();

          const { result, readdirCalls } = await withReaddirRefusedOnce(code, async () => ({
            first: await cache.readdir(tempDir),
            second: await cache.readdir(tempDir),
          }));

          expect(result.first).toEqual({ outcome: 'unreadable', code });
          // The second ask gets the real listing — which is the whole point: the
          // directory was always readable, the process was momentarily not.
          expect(namesOf(result.second)).toEqual(['a.txt']);
          expect(readdirCalls).toBe(2);
        },
      );

      it('shares the in-flight promise through a transient refusal, so N callers cost ONE syscall', async () => {
        const cache = new FsLookupCache();

        const { result, readdirCalls } = await withReaddirRefusedOnce(
          'EMFILE',
          async () =>
            await Promise.all([
              cache.readdir(tempDir),
              cache.readdir(tempDir),
              cache.readdir(tempDir),
            ]),
        );

        // ⛔ "Do not cache the failure" must not degrade into "ask again per
        // caller": that turns a descriptor shortage into a descriptor storm,
        // which is the very condition EMFILE reports. The memo is dropped only
        // once it has SETTLED, so a concurrent wave still shares one syscall.
        expect(readdirCalls).toBe(1);
        expect(result[0]).toBe(result[1]);
        expect(result[0]).toEqual({ outcome: 'unreadable', code: 'EMFILE' });
      });
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
      expect(await firstRun.readdir(dirPath)).toEqual({ outcome: 'listed', names: ['first.txt'] });

      await fs.writeFile(safePath.join(dirPath, 'second.txt'), '');

      // Same instance: still the snapshot it took (that is the point of a per-run cache).
      expect(await firstRun.readdir(dirPath)).toEqual({ outcome: 'listed', names: ['first.txt'] });
      // A fresh instance — what a new validation run constructs — sees the new state.
      const secondRun = new FsLookupCache();
      expect(namesOf(await secondRun.readdir(dirPath))).toHaveLength(2);
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
  /**
   * Judging a whole PATH, component by component.
   *
   * 🪤 The defect this machinery exists to close: a judge that classified only
   * `basename(target)` handed every DIRECTORY component straight back to the
   * host filesystem's own folding. `readdir('<root>/Docs')` succeeds on macOS
   * when the directory is really `docs`, the basename then matches byte for
   * byte, and the caller reports nothing — for a path that 404s on every
   * case-sensitive filesystem. Both `vat resources validate` and the OKF bundle
   * lane shipped that hole; this is the one implementation they now share.
   */
  describe('path spellings', () => {
    describe('spellingWalkRoot', () => {
      it('starts at the deepest directory the referrer and the target share', () => {
        // Everything above it was enumerated off disk; everything below it is
        // what the reference TEXT contributed, and is what can be misspelled.
        expect(spellingWalkRoot('/proj/sub/a.md', '/proj/docs/g.md')).toBe('/proj');
        expect(spellingWalkRoot('/proj/docs/a.md', '/proj/docs/g.md')).toBe('/proj/docs');
      });

      it('never walks down from the filesystem root or a bare drive', () => {
        // Two paths sharing only the root separator share nothing a caller
        // owns; judging from there would list directories it has no business in.
        expect(spellingWalkRoot('/a/x.md', '/b/y.md')).toBe('/b');
      });
    });

    describe('fillPathSpellings + pathSpellingFrom', () => {
      it('judges EVERY component, and corrects the ones that are wrong', async () => {
        const root = await plantDeep(tempDir);
        const referrer = safePath.join(root, 'a.md');
        const asked = safePath.join(root, 'One', 'Two', 'three.md');

        const table = await fillPathSpellings([{ referrer, target: asked }], new FsLookupCache());

        expect(pathSpellingFrom(table, referrer, asked)).toEqual({
          match: 'case_mismatch',
          askedPath: 'One/Two/three.md',
          actualPath: PLANTED_PATH,
        });
      });

      it('descends into the CORRECTED spelling, so a wrong directory cannot hide a wrong file', async () => {
        // 🪤 A walk that descended into the asked-for spelling would `readdir`
        // `<root>/One`, get nothing on a case-sensitive host, and report the
        // whole path absent — losing the filename defect underneath it.
        const root = await plantDeep(tempDir);
        const referrer = safePath.join(root, 'a.md');
        const asked = safePath.join(root, 'One', 'two', 'Three.md');

        const table = await fillPathSpellings([{ referrer, target: asked }], new FsLookupCache());

        expect(pathSpellingFrom(table, referrer, asked).actualPath).toBe(PLANTED_PATH);
      });

      it('reports the WORST component, not the last one', async () => {
        // A path can be wrong in more than one way at once. Reporting the
        // milder verdict would understate what the author has to fix.
        const root = await plantDeep(tempDir);
        await fs.mkdir(safePath.join(root, NFC_NAME), { recursive: true });
        await fs.writeFile(safePath.join(root, NFC_NAME, 'g.md'), '');
        const referrer = safePath.join(root, 'a.md');
        const asked = safePath.join(root, NFD_NAME, 'G.md');

        const table = await fillPathSpellings([{ referrer, target: asked }], new FsLookupCache());

        expect(pathSpellingFrom(table, referrer, asked).match).toBe('case_mismatch');
      });

      it('answers `absent` with an empty correction when nothing matches', async () => {
        const root = await plantDeep(tempDir);
        const referrer = safePath.join(root, 'a.md');
        const asked = safePath.join(root, 'one', 'two', 'nowhere.md');

        const table = await fillPathSpellings([{ referrer, target: asked }], new FsLookupCache());

        // 🪤 `because` is the half that must NOT move: a fix that reported every
        // failed listing as unreadable would silence real missing files.
        expect(pathSpellingFrom(table, referrer, asked)).toEqual({
          match: 'absent',
          askedPath: 'one/two/nowhere.md',
          actualPath: '',
          because: { kind: 'no_such_entry' },
          verified: { match: 'exact', askedPath: 'one/two', actualPath: 'one/two' },
        });
      });

      /**
       * 🪤 The regression: judging EVERY component means every ancestor below
       * the walk root must now be **listable**, where the basename-only judge
       * this replaced only ever listed `dirname(target)`. A `--x` directory is
       * traversable — the file below it opens — but `readdir` is refused, and
       * that refusal used to arrive here as plain absence. The file is there;
       * only the question could not be asked.
       */
      it.skipIf(!PERMISSIONS_ENFORCED)(
        'says a path through an unlistable ancestor is unverified, not missing',
        async () => {
          const root = await plantDeep(tempDir);
          const referrer = safePath.join(root, 'a.md');
          const asked = safePath.join(root, 'one', 'two', 'three.md');

          const spelling = await withUnlistableDirectory(safePath.join(root, 'one'), async () => {
            const table = await fillPathSpellings(
              [{ referrer, target: asked }],
              new FsLookupCache(),
            );
            return pathSpellingFrom(table, referrer, asked);
          });

          expect(spelling).toEqual({
            match: 'absent',
            askedPath: PLANTED_PATH,
            actualPath: '',
            because: {
              kind: 'directory_unreadable',
              code: 'EACCES',
              directory: safePath.join(root, 'one'),
              transient: false,
            },
            verified: { match: 'exact', askedPath: 'one', actualPath: 'one' },
          });
        },
      );

      /**
       * The enumerated-vs-derived class over a real directory, both ways round.
       *
       * `readdir` hands back exactly the bytes written (APFS preserves the
       * form), so one side is decomposed while the other is composed — the
       * shape a markdown link takes in practice.
       *
       * ⚠️ This must NOT be written as an `existsSync` test. macOS is
       * normalization-*insensitive* at the syscall level, so `existsSync` on
       * the composed form returns `true` even here and would report the bug as
       * absent. What is under test is the index's own comparison, which
       * behaves identically on every platform.
       *
       * ⚠️ **Both directions, deliberately.** Which side is decomposed decides
       * nothing about the verdict, and a one-directional case would leave that
       * unproven.
       */
      const NORMALIZATION_PAIRS: readonly { label: string; onDisk: string; asked: string }[] = [
        {
          label: 'a composed query against a decomposed listing',
          onDisk: NFD_NAME,
          asked: NFC_NAME,
        },
        {
          label: 'a decomposed query against a composed listing',
          onDisk: NFC_NAME,
          asked: NFD_NAME,
        },
      ];

      it.each(NORMALIZATION_PAIRS)(
        'judges $label as present but fold-only, never byte-exact (D7)',
        async ({ onDisk, asked }) => {
          // Guard the premise twice: different as bytes, identical once folded.
          // If either ever stopped holding, the test would pass while
          // demonstrating nothing.
          expect(onDisk).not.toBe(asked);
          expect(onDisk.normalize('NFC')).toBe(asked.normalize('NFC'));

          await fs.writeFile(safePath.join(tempDir, onDisk), '');
          await fs.writeFile(safePath.join(tempDir, 'a.md'), '');
          const referrer = safePath.join(tempDir, 'a.md');
          const target = safePath.join(tempDir, asked);

          const table = await fillPathSpellings(
            [{ referrer, target }],
            new FsLookupCache()
          );

          // D7 still holds: an accented file that is really there is present,
          // not missing. The second field is what is new — the link resolves
          // ONLY because both sides were folded, so on ext4 (CI, and most
          // deploy targets) the asked-for spelling opens nothing. The
          // correction carries the entry's OWN bytes, which is the spelling an
          // author must write for it to open there.
          expect(pathSpellingFrom(table, referrer, target)).toEqual({
            match: 'normalized',
            askedPath: asked,
            actualPath: onDisk,
          });
        }
      );

      it('judges a byte-identical accented name as exact, not as a fold (control)', async () => {
        // The negative control for the rows above: same fixture, same code
        // path, and the ONE difference is that the link spells the file the way
        // disk does. Without it, `normalized` could be what this judge answers
        // for every accented filename, and the warning it drives would fire on
        // files that are perfectly fine.
        await fs.writeFile(safePath.join(tempDir, NFC_NAME), '');
        await fs.writeFile(safePath.join(tempDir, 'a.md'), '');
        const referrer = safePath.join(tempDir, 'a.md');
        const target = safePath.join(tempDir, NFC_NAME);

        const table = await fillPathSpellings([{ referrer, target }], new FsLookupCache());

        expect(pathSpellingFrom(table, referrer, target)).toEqual({
          match: 'exact',
          askedPath: NFC_NAME,
          actualPath: NFC_NAME,
        });
      });

      it('judges from a filled table, reaching neither readdir nor the sync stat pair', async () => {
        // THREE routes are instrumented, not one. `readdir` is how the fill
        // reaches disk — but `existsSync` and `statSync` are already imported at
        // the top of `fs-utils.ts` (for `FsLookupCache.probe`), so a judge that
        // started stat-ing its target is one keystroke away, and a readdir-only
        // spy stays green straight through that regression. Spying the default
        // objects, not namespace bindings, is what makes the counts real.
        const root = await plantDeep(tempDir);
        const referrer = safePath.join(root, 'a.md');
        const target = safePath.join(root, 'One', 'Two', 'three.md');
        const spies = [
          vi.spyOn(fs, 'readdir'),
          vi.spyOn(nodeFs, 'existsSync'),
          vi.spyOn(nodeFs, 'statSync'),
        ];
        const counts = (): number[] => spies.map((spy) => spy.mock.calls.length);

        const table = await fillPathSpellings([{ referrer, target }], new FsLookupCache());
        // Positive control for the sync pair: `probe` takes exactly the route a
        // regressed judge would take, through the same two module-level imports.
        // Without it, the zeros below are indistinguishable from instruments
        // that never attached to the functions under test.
        //
        // It must probe the spelling that is really ON DISK, never the asked-for
        // `target`: `probe` reaches `statSync` only when `existsSync` says yes,
        // so on a case-sensitive filesystem (ext4 in CI) `One/Two` opens nothing
        // and the control silently exercises one of the two syscalls it exists to
        // exercise. The assertion below pins that property rather than trusting
        // it — `exists` is `statSync`'s own guard, and `isDirectory: false` is a
        // value only `statSync` can have produced.
        const control = new FsLookupCache().probe(safePath.join(root, PLANTED_PATH));
        expect(control).toEqual({ exists: true, isDirectory: false });

        expect(counts().every((n) => n > 0)).toBe(true);
        const beforeJudging = counts();

        expect(pathSpellingFrom(table, referrer, target).actualPath).toBe(PLANTED_PATH);

        expect(counts()).toEqual(beforeJudging);
        vi.restoreAllMocks();
      });

      it('throws when the table has no row for this reference', async () => {
        // A miss is a fill/judge divergence, i.e. a programming error, so it
        // is loud rather than degrading to "missing" — a wrong answer wearing
        // the shape of a graceful one.
        const root = await plantDeep(tempDir);
        const referrer = safePath.join(root, 'a.md');

        expect(() =>
          pathSpellingFrom(new Map(), referrer, safePath.join(root, 'unfilled.md')),
        ).toThrow('unfilled.md');
      });
    });

    describe('DirectorySpellingIndex — the cost of judging, and how far it reaches', () => {
      // ⛔ Deliberately NOT a wall-clock budget. A literal number of
      // milliseconds makes the machine a silent second requirement, and the
      // assertion then passes or fails on load rather than on the code. What is
      // asserted is the WORK: each directory is listed and indexed once,
      // whatever the path count.

      it('indexes a directory ONCE however many paths point into it', async () => {
        const names = Array.from({ length: 50 }, (_, n) => `neighbour-${n}.md`);
        for (const name of names) await fs.writeFile(safePath.join(tempDir, name), '');
        const index = new DirectorySpellingIndex(new FsLookupCache());

        await Promise.all(
          names.map(async (name) => await index.judgePath(tempDir, safePath.join(tempDir, name))),
        );

        expect(index.directoriesIndexed).toBe(1);
        expect(index.entriesIndexed).toBe(names.length);
        expect(index.indexedDirectories).toEqual([tempDir]);
      });

      it('shares one index across the components of a nested path', async () => {
        const root = await plantDeep(tempDir);
        const index = new DirectorySpellingIndex(new FsLookupCache());

        await index.judgePath(root, safePath.join(root, 'one', 'two', 'three.md'));
        await index.judgePath(root, safePath.join(root, 'one', 'two', 'three.md'));

        // root, one, one/two — three directories for two judgements of depth
        // three, not one listing per component per path.
        expect(index.directoriesIndexed).toBe(3);
      });

      it('refuses to judge a path that is not under the walk root', async () => {
        // A verdict that depends on a directory ABOVE the root is a verdict
        // that changes when the tree moves.
        const root = await plantDeep(tempDir);
        const index = new DirectorySpellingIndex(new FsLookupCache());

        await expect(
          index.judgePath(safePath.join(root, 'one'), safePath.join(root, 'a.md')),
        ).rejects.toThrow('above the walk root');
      });

      it('says the root itself resolves without listing its PARENT', async () => {
        // 🪤 A judge deriving `dirname(target)` would list the root's parent —
        // a directory outside the tree under judgement, and one that may not be
        // listable at all.
        const root = await plantDeep(tempDir);
        const index = new DirectorySpellingIndex(new FsLookupCache());

        expect(await index.judgePath(root, root)).toEqual({
          match: 'exact',
          askedPath: '',
          actualPath: '',
        });
        expect(index.indexedDirectories).toEqual([]);
      });

      it('answers `absent` for a directory that is not there', async () => {
        const index = new DirectorySpellingIndex(new FsLookupCache());
        const missing = safePath.join(tempDir, NO_SUCH_DIR);

        expect(await index.lookup(missing, ANY_NAME)).toEqual({
          match: 'absent',
          because: { kind: 'no_such_entry' },
        });
      });

      it.skipIf(!PERMISSIONS_ENFORCED)(
        'separates a directory it was REFUSED from one that is not there',
        async () => {
          // Both are "no answer", and one `null` used to be both. Only the
          // first is evidence that the entry does not exist.
          const closed = safePath.join(tempDir, 'closed-lookup');
          await fs.mkdir(closed, { recursive: true });
          const index = new DirectorySpellingIndex(new FsLookupCache());

          const found = await withUnlistableDirectory(
            closed,
            async () => await index.lookup(closed, ANY_NAME),
          );

          expect(found).toEqual({
            match: 'absent',
            because: {
              kind: 'directory_unreadable',
              code: 'EACCES',
              directory: closed,
              transient: false,
            },
          });
        },
      );

      /**
       * 🪤 **A second memo sits above the listing memo.** `DirectorySpellingIndex`
       * caches the built INDEX, not just the listing, so evicting a transient
       * refusal from `FsLookupCache` alone leaves the refusal pinned exactly
       * where every consumer reads it. The fix would be real and invisible.
       */
      it.each(STABLE_REFUSALS)(
        'keeps a %s refusal, so a stable denial is still listed once',
        async (code) => {
          const root = await plantDeep(tempDir);
          const index = new DirectorySpellingIndex(new FsLookupCache());
          const target = safePath.join(root, 'one', 'two', 'three.md');

          const { result, readdirCalls } = await withReaddirRefusedOnce(code, async () => ({
            first: await index.judgePath(root, target),
            second: await index.judgePath(root, target),
          }));

          expect(result.first.match).toBe('absent');
          expect(result.second.match).toBe('absent');
          expect(readdirCalls).toBe(1);
          expect(index.directoriesIndexed).toBe(1);
        },
      );

      it.each(TRANSIENT_REFUSALS)(
        're-asks after a %s refusal at the INDEX layer, not only at the listing memo',
        async (code) => {
          const root = await plantDeep(tempDir);
          const index = new DirectorySpellingIndex(new FsLookupCache());
          const target = safePath.join(root, 'one', 'two', 'three.md');

          const { result } = await withReaddirRefusedOnce(code, async () => ({
            first: await index.judgePath(root, target),
            second: await index.judgePath(root, target),
          }));

          expect(result.first.match).toBe('absent');
          expect(result.second).toEqual({
            match: 'exact',
            askedPath: PLANTED_PATH,
            actualPath: PLANTED_PATH,
          });
        },
      );
    });

    /**
     * 🪤 Every refusal used to collapse to the bare word `directory_unreadable`,
     * so no message downstream could say WHICH errno or WHICH directory refused
     * — leaving a reader of a five-segment path with "a directory on that path"
     * and a remedy they cannot aim.
     */
    describe('an absence says WHICH directory refused, with WHAT errno', () => {
      it.each(ALL_REFUSALS)('carries %s and the refusing directory', async (code) => {
        const closed = safePath.join(tempDir, 'closed-cause');
        await fs.mkdir(closed, { recursive: true });
        const index = new DirectorySpellingIndex(new FsLookupCache());

        const { result } = await withReaddirRefusedOnce(
          code,
          async () => await index.lookup(closed, ANY_NAME),
        );

        expect(result).toEqual({
          match: 'absent',
          because: {
            kind: 'directory_unreadable',
            code,
            directory: closed,
            // Derived here rather than by each consumer: two lanes write a
            // "re-run and see" remedy off this, and a second errno list is how
            // they come to disagree about which refusals are worth re-running.
            transient: TRANSIENT_REFUSALS.includes(code as (typeof TRANSIENT_REFUSALS)[number]),
          },
        });
      });

      it('says `no_such_entry` and nothing else when the directory WAS listed', async () => {
        // The negative control. A cause that carried an errno for a plain miss
        // would let every genuinely missing file read as a refusal.
        const root = await plantDeep(tempDir);
        const index = new DirectorySpellingIndex(new FsLookupCache());

        expect(await index.lookup(root, 'nowhere.md')).toEqual({
          match: 'absent',
          because: { kind: 'no_such_entry' },
        });
      });

      it.skipIf(!PERMISSIONS_ENFORCED)(
        'names the ANCESTOR that refused, not the walk root and not the target parent',
        async () => {
          const root = await plantDeep(tempDir);
          const index = new DirectorySpellingIndex(new FsLookupCache());
          const refused = safePath.join(root, 'one');

          const spelling = await withUnlistableDirectory(
            refused,
            async () => await index.judgePath(root, safePath.join(root, 'one', 'two', 'three.md')),
          );

          // Guard the premise: the three candidates a wrong implementation
          // would hand back are all distinct from each other here, so the
          // assertion below cannot pass by coincidence.
          expect(refused).not.toBe(root);
          expect(refused).not.toBe(safePath.join(root, 'one', 'two'));
          expect(spelling).toEqual({
            match: 'absent',
            askedPath: PLANTED_PATH,
            actualPath: '',
            because: {
              kind: 'directory_unreadable',
              code: 'EACCES',
              directory: refused,
              transient: false,
            },
            verified: { match: 'exact', askedPath: 'one', actualPath: 'one' },
          });
        },
      );

      /**
       * 🪤 A refusal must not DISCARD what the walk had already learned. The
       * components above the refusing directory WERE listed and judged, and a
       * case mismatch found there is a defect on its own — that link 404s on a
       * case-sensitive filesystem whatever the mode bit below says. Returning
       * bare `absent` threw the verdict away, and the message downstream then
       * called the spelling "unverified" about a component VAT had verified
       * and found wrong.
       */
      it.skipIf(!PERMISSIONS_ENFORCED)(
        'carries the spelling defect it found ABOVE the directory that refused',
        async () => {
          const root = await plantDeep(tempDir);
          const index = new DirectorySpellingIndex(new FsLookupCache());
          const refused = safePath.join(root, 'one');

          const spelling = await withUnlistableDirectory(
            refused,
            async () => await index.judgePath(root, safePath.join(root, 'One', 'two', 'three.md')),
          );

          expect(spelling.match).toBe('absent');
          if (spelling.match !== 'absent') return;
          expect(spelling.because.kind).toBe('directory_unreadable');
          expect(spelling.verified).toEqual({ match: 'case_mismatch', askedPath: 'One', actualPath: 'one' });
        },
      );

      it('reports an empty verified prefix when the FIRST component is what is missing', async () => {
        const root = await plantDeep(tempDir);
        const index = new DirectorySpellingIndex(new FsLookupCache());

        const spelling = await index.judgePath(root, safePath.join(root, 'nowhere', 'x.md'));

        expect(spelling.match).toBe('absent');
        if (spelling.match !== 'absent') return;
        expect(spelling.verified).toEqual({ match: 'exact', askedPath: '', actualPath: '' });
      });
    });
  });
});
