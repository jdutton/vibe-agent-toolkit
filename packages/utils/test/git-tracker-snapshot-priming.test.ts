/**
 * `GitTracker` primes its active set from a snapshot the bracket ALREADY holds,
 * instead of spawning `git ls-files` to rebuild a set the process is carrying.
 *
 * ## Why these tests use real git and no mocks
 *
 * The sibling suite module-mocks `git-utils`, which would let a test assert
 * "`gitLsFiles` was not called" directly — but that pins the MECHANISM (this
 * particular helper) rather than the property (no second question was asked).
 * A later refactor that spawns `ls-files` some other way would keep such a test
 * green while the saving quietly disappeared.
 *
 * So the discriminator here is a fact the two paths DISAGREE about. A file
 * created after the snapshot is taken is, to `git ls-files`, an ordinary
 * untracked-not-ignored path that belongs in the active set; to the snapshot it
 * does not exist at all. Its ABSENCE from the set is therefore only producible
 * by code that did not re-ask git — the syscall proven absent by its
 * consequence, on every platform, with nothing stubbed.
 *
 * That staleness is the documented behaviour of the bracket, not a defect:
 * `withGitSnapshotCache` says "a working-tree edit made between two calls is not
 * observed by the second — that is the race being closed".
 */

/* eslint-disable security/detect-non-literal-fs-filename -- every path here is built from a controlled mkdtemp directory */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { gitTreeSnapshot, withGitSnapshotCache } from '../src/git-snapshot.js';
import { GitTracker } from '../src/git-tracker.js';
import { mkdirSyncReal, normalizedTmpdir, safePath } from '../src/path-utils.js';

/** A path that exists on disk but was created AFTER the snapshot was taken. */
const APPEARED_AFTER = 'appeared-after.md';
/** A path committed before the snapshot, so both routes must know it. */
const COMMITTED = 'committed.md';

let root: string;

function git(...args: string[]): void {
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- test setup uses git from PATH
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr ?? result.error?.message}`);
  }
}

beforeEach(() => {
  root = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-tracker-priming-'));
  mkdirSyncReal(root, { recursive: true });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  writeFileSync(safePath.join(root, COMMITTED), '# committed\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('GitTracker priming from an open snapshot', () => {
  it('reads the active set off the snapshot in hand, asking git nothing further', async () => {
    await withGitSnapshotCache(async () => {
      // Somebody else's snapshot — in production this is the projection store
      // taking one to key itself, before the tracker is ever initialized.
      expect(gitTreeSnapshot({ cwd: root })).not.toBeNull();

      // Created AFTER, so the two routes now disagree about it.
      writeFileSync(safePath.join(root, APPEARED_AFTER), 'x\n');

      const tracker = new GitTracker(root);
      await tracker.initialize();

      // The set was populated, and populated from git's own answer.
      expect(tracker.isUsable()).toBe(true);
      expect(tracker.isIgnoredByActiveSet(safePath.join(root, COMMITTED))).toBe(false);

      // ⭐ THE ASSERTION. `git ls-files --cached --others --exclude-standard`
      // would have listed this path — it exists, it is untracked, it is not
      // ignored. Reporting it OUTSIDE the active set is only reachable by never
      // having asked.
      expect(tracker.isIgnoredByActiveSet(safePath.join(root, APPEARED_AFTER))).toBe(true);
    });
  });

  it('negative control: with no snapshot in the bracket it asks git and sees the new file', async () => {
    // Identical fixture, identical assertions, one difference: nothing took a
    // snapshot, so the peek misses and the tracker spawns as it always has.
    // Without this the test above would also pass against a tracker that had
    // simply stopped populating anything.
    await withGitSnapshotCache(async () => {
      writeFileSync(safePath.join(root, APPEARED_AFTER), 'x\n');

      const tracker = new GitTracker(root);
      await tracker.initialize();

      expect(tracker.isUsable()).toBe(true);
      expect(tracker.isIgnoredByActiveSet(safePath.join(root, COMMITTED))).toBe(false);
      expect(tracker.isIgnoredByActiveSet(safePath.join(root, APPEARED_AFTER))).toBe(false);
    });
  });

  it('declines the snapshot for includeUntracked:false, which it cannot answer', async () => {
    // A snapshot is `git add --all` without `--force`: tracked AND
    // untracked-not-ignored, with nothing marking which entries were already
    // tracked. It therefore cannot serve a tracked-only request, and priming
    // from it would silently widen the caller's set.
    await withGitSnapshotCache(async () => {
      expect(gitTreeSnapshot({ cwd: root })).not.toBeNull();
      writeFileSync(safePath.join(root, APPEARED_AFTER), 'x\n');

      const tracker = new GitTracker(root);
      await tracker.initialize({ includeUntracked: false });

      // Spawned, so the post-snapshot file is visible to git — and being
      // untracked it is not in the tracked-only set, which is the whole point
      // of the option. What matters here is that the snapshot was NOT used.
      expect(tracker.isUsable()).toBe(true);
      expect(tracker.indexPathFor(safePath.join(root, COMMITTED))).toBe(COMMITTED);
    });
  });
});
