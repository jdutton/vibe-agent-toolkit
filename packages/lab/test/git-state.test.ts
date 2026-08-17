/**
 * The git reference a population report is held against.
 *
 * Two properties, and each has already been a real defect somewhere in this
 * codebase rather than a hypothetical:
 *
 * 1. **`null` is not an empty set.** A subject outside git has to stay
 *    distinguishable from a subject git tracks nothing in, because a caller
 *    reading the second as the first reports the entire enumerated population as
 *    "paths git does not track".
 * 2. **A path beginning with a space survives.** git sorts by byte value and
 *    0x20 sorts below every printable character, so such a path is listed FIRST
 *    in a `-z` stream — exactly where a `.trim()` reaches it. The trimmed reading
 *    hands back a path that does not exist, so every membership test against it
 *    reads as "not tracked" and the instrument reports a divergence that is its
 *    own.
 */

import { setupSyncTempDirSuite } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { trackedPaths } from '../src/harness/git-state.js';

import { commitAll, git, initRepo, writeFixtureFile } from './git-fixtures.js';

/** Fixture file content. Never asserted on — only the path list is. */
const CONTENT = 'one\n';
const OTHER_CONTENT = 'two\n';
const COMMIT_MESSAGE = 'initial';

/**
 * A tracked path beginning with a space — git lists it FIRST in a NUL-delimited
 * stream, which is exactly where a trim on the whole stream would reach it.
 */
const SPACED_PATH = ' leading-space.md';

const suite = setupSyncTempDirSuite('lab-git-state');

beforeAll(suite.beforeAll);
afterAll(suite.afterAll);
beforeEach(suite.beforeEach);

describe('git fixture helpers', () => {
  it('REFUSE to run without a fixture root, rather than falling back to the cwd', () => {
    // Not hypothetical: a mistyped accessor on the temp-dir suite handed these
    // `undefined`, and `runGit`'s optional `cwd` turned that into
    // `git symbolic-ref HEAD` against the developer's own worktree.
    expect(() => git(['status'], undefined as unknown as string)).toThrow(/no fixture root/);
    expect(() => git(['status'], '')).toThrow(/no fixture root/);
  });
});

describe('trackedPaths', () => {
  it('lists every committed path, relative to the directory it was asked about', () => {
    const root = suite.getTempDir();
    initRepo(root);
    writeFixtureFile(root, 'docs/a.md', CONTENT);
    writeFixtureFile(root, 'b.md', OTHER_CONTENT);
    commitAll(root, COMMIT_MESSAGE);

    expect(trackedPaths(root)).toEqual(new Set(['b.md', 'docs/a.md']));
  });

  it('omits an untracked file, which is the whole basis of the off-git reading', () => {
    const root = suite.getTempDir();
    initRepo(root);
    writeFixtureFile(root, 'tracked.md', CONTENT);
    commitAll(root, COMMIT_MESSAGE);
    writeFixtureFile(root, 'untracked.md', OTHER_CONTENT);

    expect(trackedPaths(root)).toEqual(new Set(['tracked.md']));
  });

  it('keeps a leading space on a tracked path, where a trim would eat it', () => {
    const root = suite.getTempDir();
    initRepo(root);
    writeFixtureFile(root, SPACED_PATH, CONTENT);
    writeFixtureFile(root, 'zzz.md', OTHER_CONTENT);
    commitAll(root, COMMIT_MESSAGE);

    const tracked = trackedPaths(root);

    // git lists this one FIRST, so a trim on the whole `-z` stream reaches it.
    expect(tracked?.has(SPACED_PATH)).toBe(true);
    expect(tracked?.has('leading-space.md')).toBe(false);
  });

  it('returns null outside a repository, which is not the same as an empty set', () => {
    expect(trackedPaths(suite.getTempDir())).toBeNull();
  });

  it('returns an EMPTY set for a repository with nothing committed', () => {
    // The other half of the pair above. A repo that tracks nothing is a real
    // answer; "there is no repo" is the absence of one.
    const root = suite.getTempDir();
    initRepo(root);
    writeFixtureFile(root, 'never-added.md', CONTENT);

    expect(trackedPaths(root)).toEqual(new Set());
  });
});
