/**
 * `GitTracker`'s active set is built from `git ls-files --cached --others
 * --exclude-standard`, and that listing walks the working tree: a directory
 * git cannot open is OMITTED from it, with the only trace on stderr. The
 * tracker used to ignore that trace, so an untracked, non-ignored file under a
 * traversable-but-unlistable (`--x`) directory was absent from the set, existed
 * on disk, and `isIgnoredByActiveSet` — whose rule is "absent and present on
 * disk ⇒ ignored" — called it GITIGNORED while `git check-ignore` said it was
 * not. Every consumer of that answer (the gitignore-leak judge, the link graph
 * walker, audit's distributed-tree lane) was one refused `opendir` away from a
 * wrong verdict with no finding.
 *
 * Now the tracker adopts the listing's `unreadable` policy (degrade): a refused
 * directory is recorded, and for anything beneath it the active set has NO
 * opinion — the question goes to `git check-ignore`, which answers from the
 * ignore PATTERNS and needs no listing. The directory itself is non-ignored by
 * construction (git opened it because it was not ignored) and is kept as an
 * active ancestor, so walkers do not prune it either.
 *
 * Two suites: a real repository with a real `chmod 111` (the reviewer's
 * reproduction; POSIX-only, not as root), and a mocked listing that hands the
 * tracker a refusal directly so the seam is exercised on every platform.
 */
/* eslint-disable security/detect-non-literal-fs-filename -- controlled temp fixture tree */
import { chmodSync, writeFileSync } from 'node:fs';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { runGitOrThrow } from '../src/git-run.js';
import { GitTracker } from '../src/git-tracker.js';
import * as gitUtils from '../src/git-utils.js';
import { settleRefusal } from '../src/listing-refusal.js';
import { mkdirSyncReal, safePath, toForwardSlash } from '../src/path-utils.js';
import { setupSyncTempDirSuite } from '../src/test-helpers.js';

import { createGitRepo } from './test-helpers.js';

/** `chmod` denies nothing to uid 0 and binds nothing on Windows. */
const CANNOT_DENY_READS =
  process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0);

const UNLISTABLE_DIR = 'x-untracked';
const UNLISTABLE_FILE = `${UNLISTABLE_DIR}/u.md`;
const IGNORED_DIR = 'x-ignored';
const IGNORED_FILE = `${IGNORED_DIR}/i.md`;
const TRACKED_FILE = 'docs/a.md';

describe.skipIf(CANNOT_DENY_READS)('GitTracker under a traversable directory git could not list (real repository)', () => {
  const suite = setupSyncTempDirSuite('git-tracker-unlistable');
  let root: string;
  const locked: string[] = [];

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);
  beforeEach(() => {
    suite.beforeEach();
    root = toForwardSlash(suite.getTempDir());
    createGitRepo(root);
    runGitOrThrow(['config', 'user.email', 'test@example.com'], { cwd: root });
    runGitOrThrow(['config', 'user.name', 'Test'], { cwd: root });
    for (const dir of ['docs', UNLISTABLE_DIR, IGNORED_DIR]) mkdirSyncReal(safePath.join(root, dir), { recursive: true });
    writeFileSync(safePath.join(root, TRACKED_FILE), '# a\n');
    writeFileSync(safePath.join(root, '.gitignore'), `${IGNORED_DIR}/\n`);
    runGitOrThrow(['add', '-A'], { cwd: root });
    runGitOrThrow(['commit', '-qm', 'init'], { cwd: root });
    // After the commit: untracked and ignored respectively.
    writeFileSync(safePath.join(root, UNLISTABLE_FILE), '# u\n');
    writeFileSync(safePath.join(root, IGNORED_FILE), '# i\n');
    // Traversable, not listable: the file can be opened by name, the directory
    // cannot be read — the `--x` case `isIgnoredByActiveSet`'s own docstring
    // names as the one where the target "may well open".
    for (const dir of [UNLISTABLE_DIR, IGNORED_DIR]) {
      const absolute = safePath.join(root, dir);
      chmodSync(absolute, 0o111);
      locked.push(absolute);
    }
  });
  afterEach(() => {
    for (const dir of locked.splice(0)) chmodSync(dir, 0o755);
  });

  it('answers "not ignored" for the untracked file beneath it, agreeing with git check-ignore', async () => {
    const tracker = new GitTracker(root);
    await tracker.initialize();

    const file = safePath.join(root, UNLISTABLE_FILE);
    expect(tracker.isIgnored(file)).toBe(false); // git check-ignore, the oracle
    expect(tracker.isIgnoredByActiveSet(file)).toBe(false);
  });

  it('keeps the refused directory itself as non-ignored and worth descending into', async () => {
    const tracker = new GitTracker(root);
    await tracker.initialize();

    const directory = safePath.join(root, UNLISTABLE_DIR);
    expect(tracker.isIgnoredByActiveSet(directory)).toBe(false);
    expect(tracker.hasActiveDescendant(directory)).toBe(true);
    expect(tracker.hasActiveDescendant(safePath.join(root, UNLISTABLE_FILE))).toBe(true);
  });

  it('still answers "ignored" for a file under an IGNORED directory git never opened (control)', async () => {
    const tracker = new GitTracker(root);
    await tracker.initialize();

    const file = safePath.join(root, IGNORED_FILE);
    expect(tracker.isIgnored(file)).toBe(true);
    expect(tracker.isIgnoredByActiveSet(file)).toBe(true);
    expect(tracker.hasActiveDescendant(safePath.join(root, IGNORED_DIR))).toBe(false);
  });
});

describe('GitTracker adopts the listing\'s unreadable policy (mocked listing)', () => {
  const suite = setupSyncTempDirSuite('git-tracker-unlistable-mock');
  let root: string;

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);
  beforeEach(() => {
    suite.beforeEach();
    root = toForwardSlash(suite.getTempDir());
    mkdirSyncReal(safePath.join(root, UNLISTABLE_DIR), { recursive: true });
    mkdirSyncReal(safePath.join(root, 'docs'), { recursive: true });
    writeFileSync(safePath.join(root, TRACKED_FILE), '# a\n');
    writeFileSync(safePath.join(root, UNLISTABLE_FILE), '# u\n');
    // The listing omits the subtree and reports the directory, exactly as git
    // does: stdout is the shorter list, the refusal arrives through the seam.
    vi.spyOn(gitUtils, 'gitLsFiles').mockImplementation((options) => {
      settleRefusal(options.unreadable, {
        kind: 'directory_unreadable',
        code: 'EACCES',
        directory: safePath.join(root, UNLISTABLE_DIR),
        transient: false,
      });
      return [TRACKED_FILE];
    });
    vi.spyOn(gitUtils, 'isGitIgnored').mockReturnValue(false);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('asks git check-ignore about a present file beneath the refused directory instead of calling it ignored', async () => {
    const tracker = new GitTracker(root);
    await tracker.initialize();

    expect(tracker.isIgnoredByActiveSet(safePath.join(root, UNLISTABLE_FILE))).toBe(false);
    expect(gitUtils.isGitIgnored).toHaveBeenCalledTimes(1);
  });

  it('answers the ancestors of the refused directory from the set, without a spawn', async () => {
    const tracker = new GitTracker(root);
    await tracker.initialize();

    expect(tracker.isIgnoredByActiveSet(safePath.join(root, UNLISTABLE_DIR))).toBe(false);
    expect(tracker.hasActiveDescendant(safePath.join(root, UNLISTABLE_DIR))).toBe(true);
    expect(gitUtils.isGitIgnored).not.toHaveBeenCalled();
  });

  it('does not widen the fallback to siblings the listing DID cover', async () => {
    const tracker = new GitTracker(root);
    await tracker.initialize();
    writeFileSync(safePath.join(root, 'docs', 'stray.md'), '# stray\n');

    // Present, absent from the set, and NOT beneath the refusal: the set is
    // still authoritative, so this is ignored with no spawn.
    expect(tracker.isIgnoredByActiveSet(safePath.join(root, 'docs', 'stray.md'))).toBe(true);
    expect(gitUtils.isGitIgnored).not.toHaveBeenCalled();
  });
});
