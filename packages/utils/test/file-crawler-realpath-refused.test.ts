/**
 * `alreadyWalked` (the symlink-following walk's realpath guard) used to
 * `catch { return true }` around `realpathSync.native`, so a directory whose
 * real path the OS REFUSED to give was recorded as "already walked" and skipped
 * — silently, on the one route (`followSymlinks: true`) that pays a realpath per
 * directory. That is the same shorter-list defect `walkDirectory`'s readdir
 * catch had, one call earlier.
 *
 * The refusal is produced by a `realpathSync.native` spy scoped to one directory
 * rather than by `chmod`, for the reason `file-crawler-refused-listing.test.ts`
 * gives: `chmod` reaches one errno, only where POSIX modes bind, and not as root.
 * The absence errnos are the negative control: a directory that vanished
 * between being listed and being canonicalised is not in the population.
 */
import fs from 'node:fs';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  crawlDirectorySync,
  DirectoryListingRefusedError,
  type DirectoryRefusal,
  type UnreadablePolicy,
} from '../src/file-crawler.js';
import { toForwardSlash } from '../src/path-utils.js';
import { setupSyncTempDirSuite } from '../src/test-helpers.js';

import { plantOpenAndLockedTree } from './test-helpers.js';

const REFUSAL_ERRNOS = ['EACCES', 'ELOOP', 'ENAMETOOLONG'] as const;
const ABSENCE_ERRNOS = ['ENOENT', 'ENOTDIR'] as const;
const OPEN_FILE = 'docs/open/ok.md';
const LOCKED_FILE = 'docs/locked/t.md';
const REMEDY = 'Fix the permissions on that directory, or add it to the plugin `exclude:` list.';

/** Make `realpathSync.native` refuse ONE directory with `code`; every other path passes through. */
function refuseRealpathOf(directory: string, code: string): () => void {
  const refused = toForwardSlash(directory);
  const original = fs.realpathSync.native;
  const spy = vi.spyOn(fs.realpathSync, 'native').mockImplementation(((target: fs.PathLike, options?: unknown) => {
    if (toForwardSlash(String(target)) === refused) {
      throw Object.assign(new Error(`${code}: refused, realpath '${String(target)}'`), { code });
    }
    return (original as (...args: unknown[]) => string)(target, options);
  }) as typeof fs.realpathSync.native);
  return () => spy.mockRestore();
}

/** The symlink-following walk lane: the only route that canonicalises each directory. */
function crawlFollowing(root: string, unreadable: UnreadablePolicy = { refuse: { root, remedy: REMEDY } }): string[] {
  return crawlDirectorySync({
    baseDir: root,
    include: ['**/*.md'],
    absolute: false,
    respectGitignore: false,
    followSymlinks: true,
    unreadable,
  }).map((relativePath) => toForwardSlash(relativePath));
}

describe('crawlDirectorySync (followSymlinks): a refused realpath never becomes a shorter list', () => {
  const suite = setupSyncTempDirSuite('file-crawler-realpath-refused');
  let root: string;
  let locked: string;
  let restore: (() => void) | undefined;

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);
  beforeEach(() => {
    suite.beforeEach();
    root = suite.getTempDir();
    ({ locked } = plantOpenAndLockedTree(root));
  });
  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  it('enumerates both files when nothing refuses (positive control)', () => {
    expect(crawlFollowing(root).sort((a, b) => a.localeCompare(b))).toEqual([LOCKED_FILE, OPEN_FILE]);
  });

  it.each(REFUSAL_ERRNOS)('throws DirectoryListingRefusedError on %s under `refuse`', (code) => {
    restore = refuseRealpathOf(locked, code);
    let thrown: unknown;
    try {
      crawlFollowing(root);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DirectoryListingRefusedError);
    const { refusal } = thrown as DirectoryListingRefusedError;
    expect(refusal.code).toBe(code);
    expect(refusal.directory).toBe(toForwardSlash(locked));
  });

  it.each(REFUSAL_ERRNOS)('hands %s to `degrade`, does not descend, and keeps walking every readable sibling', (code) => {
    restore = refuseRealpathOf(locked, code);
    const refusals: DirectoryRefusal[] = [];
    const files = crawlFollowing(root, { degrade: (refusal) => refusals.push(refusal) });
    expect(files).toEqual([OPEN_FILE]);
    expect(refusals).toEqual([
      { kind: 'directory_unreadable', code, directory: toForwardSlash(locked), transient: false },
    ]);
  });

  it.each(ABSENCE_ERRNOS)('skips a directory that vanished before it could be canonicalised (%s) without a refusal', (code) => {
    restore = refuseRealpathOf(locked, code);
    const refusals: DirectoryRefusal[] = [];
    expect(crawlFollowing(root, { degrade: (refusal) => refusals.push(refusal) })).toEqual([OPEN_FILE]);
    expect(refusals).toEqual([]);
    expect(crawlFollowing(root)).toEqual([OPEN_FILE]);
  });
});
