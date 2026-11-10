/**
 * A snapshot runs `git add --all`, which reads every un-ignored file's bytes —
 * so ONE file the OS will not read, anywhere in the repository and referenced by
 * nothing, makes git refuse the whole snapshot. The crawl that needs it used to
 * throw an uncoded "it is not a git repository" about a directory that is one.
 * The one classifier (`gitSnapshotFailureOf`) names the file instead.
 */

import { chmodSync, writeFileSync } from 'node:fs';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { GIT_NO_ANSWER_CODE, GIT_SNAPSHOT_UNREADABLE_CODE, gitSnapshotFailureOf } from '../../src/git-no-answer.js';
import { gitTreeSnapshot, type GitSnapshotOutcome, unreadableSnapshotReason } from '../../src/git-snapshot.js';
import { safePath } from '../../src/path-utils.js';
import { CANNOT_DENY_READS } from '../../src/testing/platform-gates.js';
import { setupSyncTempDirSuite } from '../../src/testing/temp-dir.js';
import { createGitRepo } from '../test-helpers.js';

/** The classifier's answer for a snapshot that must have failed. */
function causeOf(outcome: GitSnapshotOutcome): ReturnType<typeof gitSnapshotFailureOf> {
  if (outcome.ok) throw new Error('expected the snapshot to fail');
  return gitSnapshotFailureOf(outcome);
}

describe('a snapshot git refuses for an unreadable file', () => {
  const suite = setupSyncTempDirSuite('git-snapshot-unreadable');
  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);
  beforeEach(suite.beforeEach);

  it.skipIf(CANNOT_DENY_READS)('names the file git could not read, coded as the input\'s refusal', () => {
    const root = createGitRepo(suite.getTempDir());
    writeFileSync(safePath.join(root, 'readme.md'), '# readable\n');
    const secret = safePath.join(root, 'secret.txt');
    writeFileSync(secret, 'nobody reads this\n');
    chmodSync(secret, 0o000);

    try {
      const cause = causeOf(gitTreeSnapshot({ cwd: root }));

      expect(cause.code).toBe(GIT_SNAPSHOT_UNREADABLE_CODE);
      expect(cause.reason).toContain('secret.txt');
      expect(cause.reason).not.toContain('readme.md');
    } finally {
      chmodSync(secret, 0o644);
    }
  });

  it('has nothing to say about a repository whose files are all readable', () => {
    const root = createGitRepo(suite.getTempDir());
    writeFileSync(safePath.join(root, 'readme.md'), '# readable\n');

    expect(unreadableSnapshotReason(root)).toBeUndefined();
  });

  it('calls a directory in no repository not a repository, never unreadable', () => {
    const cause = causeOf(gitTreeSnapshot({ cwd: suite.getTempDir() }));

    expect(cause.code).toBe(GIT_NO_ANSWER_CODE);
    expect(cause.reason).toContain('it is not a git repository');
  });
});
