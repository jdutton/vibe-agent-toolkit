/**
 * The GIT route of `crawlDirectorySync` must surface a refused directory the
 * way the walk route does — through `onUnreadable`, or by throwing.
 *
 * 🪤 The route's docstring used to say "git does not list directories", and for
 * `git ls-files --cached` that is true. With `--others` it is not: git walks the
 * working tree for untracked files, and on a directory it cannot open it prints
 * `warning: could not open directory '<dir>/': Permission denied` to stderr,
 * exits 0, and hands back a shorter list. Every registry crawl passes
 * `includeUntracked: true`, so on the default arm a locked directory holding
 * untracked files was simply absent at `status: success` — while the walk arm
 * refused the identical tree. The sibling suite
 * (`file-crawler-refused-listing.test.ts`) covers only `respectGitignore: false`,
 * which is exactly why this gap had no test.
 *
 * A real repository and a real `chmod 000`, not a `readdirSync` spy: the walk
 * under test is git's own, and no Node-level spy reaches it. That buys one errno
 * (`EACCES`) on POSIX only, so the suite skips itself on Windows and as root —
 * the same rule `audit-unreadable-path.integration.test.ts` applies.
 */
/* eslint-disable security/detect-non-literal-fs-filename -- controlled temp fixture tree */
import { chmodSync, writeFileSync } from 'node:fs';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  crawlDirectorySync,
  DirectoryListingRefusedError,
  type DirectoryRefusal,
} from '../src/file-crawler.js';
import { runGitOrThrow } from '../src/git-run.js';
import { mkdirSyncReal, safePath, toForwardSlash } from '../src/path-utils.js';
import { setupSyncTempDirSuite } from '../src/test-helpers.js';

import { createGitRepo } from './test-helpers.js';

/** `chmod 000` denies nothing to uid 0 and binds nothing on Windows. */
const CANNOT_DENY_READS =
  process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0);

const OPEN_FILE = 'docs/open/ok.md';
const LOCKED_DIR = 'docs/locked';
const TRACKED_LOCKED_DIR = 'docs/locked-tracked';
const TRACKED_LOCKED_FILE = `${TRACKED_LOCKED_DIR}/tr.md`;
const IGNORED_LOCKED_DIR = 'build/locked';

/**
 * `docs/open/ok.md` and `docs/locked-tracked/tr.md` committed; `docs/locked/t.md`
 * untracked; `build/locked/b.md` gitignored. The two locked directories that are
 * NOT ignored are the ones git has to open to find untracked files.
 */
function plantRepo(root: string): void {
  createGitRepo(root);
  runGitOrThrow(['config', 'user.email', 'test@example.com'], { cwd: root });
  runGitOrThrow(['config', 'user.name', 'Test'], { cwd: root });
  for (const dir of ['docs/open', LOCKED_DIR, TRACKED_LOCKED_DIR, IGNORED_LOCKED_DIR]) {
    mkdirSyncReal(safePath.join(root, dir), { recursive: true });
  }
  writeFileSync(safePath.join(root, OPEN_FILE), '# ok\n');
  writeFileSync(safePath.join(root, TRACKED_LOCKED_FILE), '# tracked\n');
  writeFileSync(safePath.join(root, '.gitignore'), 'build/\n');
  runGitOrThrow(['add', '-A'], { cwd: root });
  runGitOrThrow(['commit', '-qm', 'init'], { cwd: root });
  // After the commit, so they are untracked / ignored rather than staged.
  writeFileSync(safePath.join(root, LOCKED_DIR, 't.md'), '# t\n');
  writeFileSync(safePath.join(root, IGNORED_LOCKED_DIR, 'b.md'), '# b\n');
}

/** The git route: `respectGitignore: true` inside a repository, untracked included. */
function crawlGit(
  root: string,
  options: { onUnreadable?: (refusal: DirectoryRefusal) => void; exclude?: string[]; includeUntracked?: boolean } = {},
): string[] {
  return crawlDirectorySync({
    baseDir: root,
    include: ['**/*.md'],
    absolute: false,
    respectGitignore: true,
    includeUntracked: options.includeUntracked ?? true,
    ...(options.exclude === undefined ? {} : { exclude: options.exclude }),
    ...(options.onUnreadable === undefined ? {} : { onUnreadable: options.onUnreadable }),
  }).map((relativePath) => toForwardSlash(relativePath));
}

/** Order-free comparison: `git ls-files` sorts by byte value, and this suite is about membership. */
function expectSameFiles(actual: string[], expected: string[]): void {
  const byName = (a: string, b: string): number => a.localeCompare(b);
  expect([...actual].sort(byName)).toEqual([...expected].sort(byName));
}

describe.skipIf(CANNOT_DENY_READS)('crawlDirectorySync git route: a directory git could not open is a refusal, not a shorter list', () => {
  const suite = setupSyncTempDirSuite('file-crawler-git-refused');
  let root: string;
  const locked: string[] = [];

  const lock = (relative: string): string => {
    const absolute = safePath.join(root, relative);
    chmodSync(absolute, 0o000);
    locked.push(absolute);
    return toForwardSlash(absolute);
  };

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);
  beforeEach(() => {
    suite.beforeEach();
    root = suite.getTempDir();
    plantRepo(root);
  });
  afterEach(() => {
    for (const dir of locked.splice(0)) chmodSync(dir, 0o755);
  });

  it('enumerates all three files when nothing is locked (positive control)', () => {
    expectSameFiles(crawlGit(root), [`${LOCKED_DIR}/t.md`, TRACKED_LOCKED_FILE, OPEN_FILE]);
  });

  it('hands the locked untracked directory to onUnreadable as the same DirectoryRefusal the walk produces', () => {
    const lockedAbsolute = lock(LOCKED_DIR);
    const refusals: DirectoryRefusal[] = [];

    const files = crawlGit(root, { onUnreadable: (refusal) => refusals.push(refusal) });

    expect(refusals).toEqual([
      { kind: 'directory_unreadable', code: 'EACCES', directory: lockedAbsolute, transient: false },
    ]);
    // Degrade, don't destroy: the readable siblings are still enumerated.
    expectSameFiles(files, [TRACKED_LOCKED_FILE, OPEN_FILE]);
  });

  it('throws DirectoryListingRefusedError when no handler is given', () => {
    const lockedAbsolute = lock(LOCKED_DIR);
    let thrown: unknown;
    try {
      crawlGit(root);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DirectoryListingRefusedError);
    expect((thrown as DirectoryListingRefusedError).refusal.directory).toBe(lockedAbsolute);
    expect((thrown as Error).message).toContain('EACCES');
  });

  it('still lists a TRACKED file inside a locked directory (the index names it) and reports the directory once', () => {
    const lockedAbsolute = lock(TRACKED_LOCKED_DIR);
    const refusals: DirectoryRefusal[] = [];

    const files = crawlGit(root, { onUnreadable: (refusal) => refusals.push(refusal) });

    expect(files).toContain(TRACKED_LOCKED_FILE);
    expect(refusals.map((refusal) => refusal.directory)).toEqual([lockedAbsolute]);
  });

  it('does not report a locked directory the caller EXCLUDED — the walk never lists one either', () => {
    lock(LOCKED_DIR);
    const refusals: DirectoryRefusal[] = [];

    const files = crawlGit(root, {
      exclude: [`${LOCKED_DIR}/**`],
      onUnreadable: (refusal) => refusals.push(refusal),
    });

    expect(refusals).toEqual([]);
    expectSameFiles(files, [TRACKED_LOCKED_FILE, OPEN_FILE]);
  });

  it('does not report a locked GITIGNORED directory — it is outside the population and git never opens it', () => {
    lock(IGNORED_LOCKED_DIR);
    const refusals: DirectoryRefusal[] = [];

    const files = crawlGit(root, { onUnreadable: (refusal) => refusals.push(refusal) });

    expect(refusals).toEqual([]);
    expectSameFiles(files, [`${LOCKED_DIR}/t.md`, TRACKED_LOCKED_FILE, OPEN_FILE]);
  });

  it('reports nothing on the tracked-only listing, which never walks the working tree (negative control)', () => {
    lock(LOCKED_DIR);
    const refusals: DirectoryRefusal[] = [];

    const files = crawlGit(root, { includeUntracked: false, onUnreadable: (refusal) => refusals.push(refusal) });

    // The population is "tracked files", and the index names every one of them:
    // no directory had to be opened, so there is no gap to report.
    expect(refusals).toEqual([]);
    expectSameFiles(files, [TRACKED_LOCKED_FILE, OPEN_FILE]);
  });
});
