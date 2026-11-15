/**
 * A refused listing on the walk that defines the POPULATION must surface —
 * thrown, or handed to a caller that asked for it — never as a shorter list.
 *
 * 🪤 `walkDirectory` used to `catch { return; }` around `readdirSync`, so a
 * `--x` directory (or a descriptor shortage, or a symlink cycle) silently
 * narrowed the crawl: every file beneath it was in the declared population,
 * was never opened, and nothing in any report said so. The link lanes had
 * already learned to report a refused listing as its own finding
 * (`LINK_TARGET_UNREADABLE`, `OKF_SUBDIRECTORY_UNREADABLE`); the crawl one
 * level up still reported success over the gap.
 *
 * The refusal is produced by a `readdirSync` spy rather than `chmod`, for the
 * reason `resources/test/helpers/refused-listing.ts` gives: `chmod` reaches
 * one errno (`EACCES`), only where POSIX modes bind, and not as root. The
 * mapping under test is "anything that is not an absence errno", so the
 * representative set is `EACCES` / `EMFILE` / `ENFILE` / `ELOOP` — and the
 * absence errnos are the negative control: a directory that VANISHED between
 * enumeration and listing is not in the population and is skipped silently.
 */
import nodeFs from 'node:fs';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { fsFaultOf } from '../src/errors/errno-table.js';
import { FS_FAULT_CODE, type FsSide } from '../src/errors/fs-fault.js';
import {
  crawlDirectorySync,
  DirectoryListingRefusedError,
  type DirectoryRefusal,
  settleCrawlRefusal,
  type UnreadablePolicy,
} from '../src/file-crawler.js';
import { safePath, toForwardSlash } from '../src/path-utils.js';
import { createSymlink, errnoError, symlinkCapability, withReaddirSyncRefused } from '../src/test-helpers.js';
import { setupSyncTempDirSuite } from '../src/testing/temp-dir.js';

import { plantOpenAndLockedTree, refuseOnSource } from './test-helpers.js';

const REFUSAL_ERRNOS = ['EACCES', 'EMFILE', 'ENFILE', 'ELOOP'] as const;
const ABSENCE_ERRNOS = ['ENOENT', 'ENOTDIR'] as const;
const OPEN_FILE = 'docs/open/ok.md';
const LOCKED_FILE = 'docs/locked/t.md';

const REMEDY = 'Fix the permissions on that directory, or add it to the plugin `exclude:` list.';

/**
 * Make `directory` really vanish at the moment it is listed: its `readdirSync` removes it, then
 * answers `code` — the race the crawl tolerates. The parent's re-read then no longer names it.
 */
function vanishOnListing(directory: string, code: string): () => void {
  const original = nodeFs.readdirSync.bind(nodeFs);
  const spy = vi.spyOn(nodeFs, 'readdirSync').mockImplementation(((target: nodeFs.PathLike, options?: unknown) => {
    if (toForwardSlash(String(target)) === toForwardSlash(directory)) {
      nodeFs.rmSync(directory, { recursive: true });
      throw errnoError(code, 'scandir', String(target));
    }
    return (original as (...args: unknown[]) => unknown)(target, options);
  }) as typeof nodeFs.readdirSync);
  return () => spy.mockRestore();
}

/** The walk lane: no git answer, so `walkDirectory` enumerates. Refuses unless told to degrade. */
function crawlWalk(root: string, unreadable: UnreadablePolicy = refuseOnSource(root, REMEDY), outputs: readonly string[] = []): string[] {
  return crawlDirectorySync({
    outputs,
    baseDir: root,
    include: ['**/*.md'],
    absolute: false,
    respectGitignore: false,
    unreadable,
  }).map((relativePath) => toForwardSlash(relativePath));
}

describe('crawlDirectorySync: a refused listing never becomes a shorter list', () => {
  const suite = setupSyncTempDirSuite('file-crawler-refused-listing');
  let root: string;
  let locked: string;

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);
  beforeEach(() => {
    suite.beforeEach();
    root = suite.getTempDir();
    ({ locked } = plantOpenAndLockedTree(root));
  });

  it('enumerates both files when nothing refuses (positive control)', () => {
    expect(crawlWalk(root).sort((a, b) => a.localeCompare(b))).toEqual([LOCKED_FILE, OPEN_FILE]);
  });

  it.each(REFUSAL_ERRNOS)('throws DirectoryListingRefusedError on %s under `refuse`', async (code) => {
    let thrown: unknown;
    try {
      await withReaddirSyncRefused(locked, code, () => crawlWalk(root));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DirectoryListingRefusedError);
    const refusal = (thrown as DirectoryListingRefusedError).refusal;
    expect(refusal.code).toBe(code);
    expect(refusal.directory).toBe(toForwardSlash(locked));
    // Derived beside the errno list in fs-utils, not re-decided here.
    expect(refusal.transient).toBe(code === 'EMFILE' || code === 'ENFILE');
    expect((thrown as Error).message).toContain(code);
  });

  it.each(REFUSAL_ERRNOS)('carries %s as a classified fault on the side the caller declared, so the refusal table decides it', async (code) => {
    for (const side of ['source', 'destination'] as const satisfies readonly FsSide[]) {
      let thrown: unknown;
      try {
        await withReaddirSyncRefused(locked, code, () => crawlWalk(root, { refuse: { root, remedy: REMEDY, side } }));
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({
        code: FS_FAULT_CODE,
        cause: { code: FS_FAULT_CODE, side, errno: code, faultClass: fsFaultOf({ code })?.faultClass, path: toForwardSlash(locked), origin: 'content' },
      });
    }
  });

  it('puts a refused BASE holding a declared output on the destination\'s side, and a directory beneath it that is no output on the policy\'s side', async () => {
    // A project crawled by a verb that writes its output inside it: the root holds what the run
    // writes (its `outputs`), everything else beneath it is content the run reads (the policy).
    const thrownFrom = async (directory: string): Promise<unknown> => {
      try {
        await withReaddirSyncRefused(directory, 'EACCES', () => crawlWalk(root, refuseOnSource(root, REMEDY), [safePath.join(root, 'dist')]));
      } catch (error) {
        return error;
      }
      return undefined;
    };

    expect(await thrownFrom(locked)).toMatchObject({ cause: { side: 'source', path: toForwardSlash(locked) } });
    expect(await thrownFrom(root)).toMatchObject({ cause: { side: 'destination', path: toForwardSlash(root) } });
  });

  it('recognises an output under another spelling of it: a link to the output is the output', ({ skip }) => {
    const capability = symlinkCapability();
    if (capability === null) {
      skip('this process cannot create symlinks');
      return;
    }
    const alias = `${root}-alias`;
    createSymlink(capability, root, alias, 'dir');
    try {
      let thrown: unknown;
      try {
        settleCrawlRefusal(refuseOnSource(root, REMEDY), { kind: 'directory_unreadable', code: 'EACCES', directory: toForwardSlash(root), transient: false }, [alias]);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({ cause: { side: 'destination' } });
    } finally {
      nodeFs.rmSync(alias);
    }
  });

  it.each(REFUSAL_ERRNOS)('hands %s to `degrade` and keeps walking every readable sibling', async (code) => {
    const refusals: DirectoryRefusal[] = [];
    const files = await withReaddirSyncRefused(locked, code, () =>
      crawlWalk(root, { degrade: (refusal) => refusals.push(refusal) }),
    );
    // The readable half is still enumerated: a refusal degrades, it does not destroy.
    expect(files).toEqual([OPEN_FILE]);
    expect(refusals).toEqual([
      { kind: 'directory_unreadable', code, directory: toForwardSlash(locked), transient: code === 'EMFILE' || code === 'ENFILE' },
    ]);
  });

  it.each(ABSENCE_ERRNOS)('skips a directory that really vanished mid-walk (%s) without a refusal: the parent agrees it is gone', (code) => {
    // Enumerated by the parent listing, gone by the time it is listed itself — the
    // parent's re-read no longer names it: not a member of the population, not a gap.
    const refusals: DirectoryRefusal[] = [];
    const restore = vanishOnListing(locked, code);
    try {
      expect(crawlWalk(root, { degrade: (refusal) => refusals.push(refusal) })).toEqual([OPEN_FILE]);
    } finally {
      restore();
    }
    expect(refusals).toEqual([]);
  });

  it.each(ABSENCE_ERRNOS)('refuses a directory whose listing says %s while the parent still names it: absence is confirmed, never assumed', async (code) => {
    // The directory is there (the parent lists it); only its own listing said "absent".
    // Read as vanished, every file beneath it was silently left out of the population.
    const refusals: DirectoryRefusal[] = [];
    const files = await withReaddirSyncRefused(locked, code, () =>
      crawlWalk(root, { degrade: (refusal) => refusals.push(refusal) }),
    );
    expect(files).toEqual([OPEN_FILE]);
    expect(refusals).toEqual([{ kind: 'directory_unreadable', code, directory: toForwardSlash(locked), transient: false }]);
    await expect(withReaddirSyncRefused(locked, code, () => crawlWalk(root))).rejects.toBeInstanceOf(DirectoryListingRefusedError);
  });

  it.each(ABSENCE_ERRNOS)('never reads the base directory vanishing (%s) as an empty population: a classified source fault', async (code) => {
    // The base was just found to exist; no parent listing enumerated it, so its
    // absence is not the mid-walk race above — an empty result would be a lie.
    await expect(withReaddirSyncRefused(root, code, () => crawlWalk(root))).rejects.toMatchObject({
      code: FS_FAULT_CODE,
      side: 'source',
      origin: 'content',
      faultClass: 'absent',
      errno: code,
    });
  });

  it('puts a base fault on what the caller declares it writes: a crawl of output this run wrote is a destination fault', async () => {
    const crawlOutput = (): string[] => crawlDirectorySync({
      baseDir: root,
      include: ['**/*.md'],
      respectGitignore: false,
      unreadable: refuseOnSource(root, REMEDY),
      outputs: [root],
    });
    await expect(withReaddirSyncRefused(root, 'ENOENT', crawlOutput)).rejects.toMatchObject({
      code: FS_FAULT_CODE,
      side: 'destination',
      faultClass: 'absent',
    });
  });

  // ONE declaration: the side of the base is derived from `outputs`, so a caller that declares an
  // output under the root cannot also label that root an input — a stray side field is not read.
  it('derives the base\'s side from the declared outputs alone: no second field relabels a root that holds an output', async () => {
    const relabelled = (): string[] => crawlDirectorySync({
      baseDir: root,
      include: ['**/*.md'],
      respectGitignore: false,
      unreadable: refuseOnSource(root, REMEDY),
      outputs: [safePath.join(root, 'dist')],
      ...({ baseSide: 'source' } as object),
    });
    await expect(withReaddirSyncRefused(root, 'ENOENT', relabelled)).rejects.toMatchObject({ code: FS_FAULT_CODE, side: 'destination', faultClass: 'absent' });
  });

  it('classifies a base directory the OS will not stat as a source fault, never a raw errno', () => {
    const original = nodeFs.statSync.bind(nodeFs);
    const spy = vi.spyOn(nodeFs, 'statSync').mockImplementation(((target: nodeFs.PathLike) => {
      if (toForwardSlash(String(target)) === toForwardSlash(root)) throw errnoError('EACCES', 'stat', String(target));
      return original(target);
    }) as typeof nodeFs.statSync);
    try {
      expect(() => crawlWalk(root)).toThrow(expect.objectContaining({ code: FS_FAULT_CODE, side: 'source', faultClass: 'refused' }));
    } finally {
      spy.mockRestore();
    }
  });

  it('refuses the base directory itself the same way', async () => {
    await expect(withReaddirSyncRefused(root, 'EACCES', () => crawlWalk(root))).rejects.toThrow(
      DirectoryListingRefusedError,
    );
  });

  describe('`refuse`: a caller that must stop names the refusal for the adopter', () => {
    it('throws the crawler error with the directory root-relative and the remedy, never the library seam', async () => {
      let thrown: unknown;
      try {
        await withReaddirSyncRefused(locked, 'EACCES', () => crawlWalk(root));
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(DirectoryListingRefusedError);
      const message = (thrown as Error).message;
      expect(message).toContain("'docs/locked'");
      expect(message).toContain('EACCES');
      expect(message).toContain(REMEDY);
      // An absolute path in an error is the developer's `$HOME` in every CI log.
      expect(message).not.toContain(root);
      // `unreadable` is the library's seam; an adopter has no such knob.
      expect(message).not.toContain('`unreadable`');
      expect((thrown as DirectoryListingRefusedError).refusal.directory).toBe(toForwardSlash(locked));
    });

    it('names a transient shortage as such instead of prescribing the remedy', async () => {
      await expect(
        withReaddirSyncRefused(locked, 'EMFILE', () => crawlWalk(root)),
      ).rejects.toThrow(/EMFILE is a transient shortage/);
    });

    it('says "the scan root itself" when the root is what refused', async () => {
      await expect(
        withReaddirSyncRefused(root, 'EACCES', () => crawlWalk(root)),
      ).rejects.toThrow(/the scan root itself/);
    });
  });
});
