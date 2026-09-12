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
/* eslint-disable security/detect-non-literal-fs-filename -- controlled temp fixture tree */
import { writeFileSync } from 'node:fs';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  crawlDirectorySync,
  DirectoryListingRefusedError,
  type DirectoryRefusal,
  refuseListing,
} from '../src/file-crawler.js';
import { mkdirSyncReal, safePath, toForwardSlash } from '../src/path-utils.js';
import { setupSyncTempDirSuite, withReaddirSyncRefused } from '../src/test-helpers.js';

const REFUSAL_ERRNOS = ['EACCES', 'EMFILE', 'ENFILE', 'ELOOP'] as const;
const ABSENCE_ERRNOS = ['ENOENT', 'ENOTDIR'] as const;
const OPEN_FILE = 'docs/open/ok.md';
const LOCKED_FILE = 'docs/locked/t.md';

/** `open/ok.md` beside `locked/t.md`: the walk must still find the one it can list. */
function plantTree(root: string): { locked: string } {
  const open = safePath.join(root, 'docs', 'open');
  const locked = safePath.join(root, 'docs', 'locked');
  mkdirSyncReal(open, { recursive: true });
  mkdirSyncReal(locked, { recursive: true });
  writeFileSync(safePath.join(open, 'ok.md'), '# ok\n');
  writeFileSync(safePath.join(locked, 't.md'), '# t\n');
  return { locked };
}

/** The walk lane: no git answer, so `walkDirectory` enumerates. */
function crawlWalk(root: string, onUnreadable?: (refusal: DirectoryRefusal) => void): string[] {
  return crawlDirectorySync({
    baseDir: root,
    include: ['**/*.md'],
    absolute: false,
    respectGitignore: false,
    ...(onUnreadable === undefined ? {} : { onUnreadable }),
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
    ({ locked } = plantTree(root));
  });

  it('enumerates both files when nothing refuses (positive control)', () => {
    expect(crawlWalk(root).sort((a, b) => a.localeCompare(b))).toEqual([LOCKED_FILE, OPEN_FILE]);
  });

  it.each(REFUSAL_ERRNOS)('throws DirectoryListingRefusedError on %s when no handler is given', async (code) => {
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

  it.each(REFUSAL_ERRNOS)('hands %s to onUnreadable and keeps walking every readable sibling', async (code) => {
    const refusals: DirectoryRefusal[] = [];
    const files = await withReaddirSyncRefused(locked, code, () =>
      crawlWalk(root, (refusal) => refusals.push(refusal)),
    );
    // The readable half is still enumerated: a refusal degrades, it does not destroy.
    expect(files).toEqual([OPEN_FILE]);
    expect(refusals).toEqual([
      { kind: 'directory_unreadable', code, directory: toForwardSlash(locked), transient: code === 'EMFILE' || code === 'ENFILE' },
    ]);
  });

  it.each(ABSENCE_ERRNOS)('skips a directory that vanished mid-walk (%s) without a refusal', async (code) => {
    // Enumerated by the parent listing, gone by the time it is listed itself:
    // not a member of the population, and not a gap in the run.
    const refusals: DirectoryRefusal[] = [];
    const files = await withReaddirSyncRefused(locked, code, () =>
      crawlWalk(root, (refusal) => refusals.push(refusal)),
    );
    expect(files).toEqual([OPEN_FILE]);
    expect(refusals).toEqual([]);
    await expect(withReaddirSyncRefused(locked, code, () => crawlWalk(root))).resolves.toEqual([OPEN_FILE]);
  });

  it('refuses the base directory itself the same way', async () => {
    await expect(withReaddirSyncRefused(root, 'EACCES', () => crawlWalk(root))).rejects.toThrow(
      DirectoryListingRefusedError,
    );
  });

  describe('refuseListing: a caller that must stop names the refusal for the adopter', () => {
    const REMEDY = 'Fix the permissions on that directory, or add it to the plugin `exclude:` list.';

    it('throws the crawler error with the directory root-relative and the remedy, never the library seam', async () => {
      let thrown: unknown;
      try {
        await withReaddirSyncRefused(locked, 'EACCES', () =>
          crawlWalk(root, refuseListing({ root, remedy: REMEDY })),
        );
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
      // `onUnreadable` is the library's seam; an adopter has no such knob.
      expect(message).not.toContain('onUnreadable');
      expect((thrown as DirectoryListingRefusedError).refusal.directory).toBe(toForwardSlash(locked));
    });

    it('names a transient shortage as such instead of prescribing the remedy', async () => {
      await expect(
        withReaddirSyncRefused(locked, 'EMFILE', () => crawlWalk(root, refuseListing({ root, remedy: REMEDY }))),
      ).rejects.toThrow(/EMFILE is a transient shortage/);
    });

    it('says "the scan root itself" when the root is what refused', async () => {
      await expect(
        withReaddirSyncRefused(root, 'EACCES', () => crawlWalk(root, refuseListing({ root, remedy: REMEDY }))),
      ).rejects.toThrow(/the scan root itself/);
    });
  });
});
