/**
 * A snapshot runs `git add --all`, which reads every un-ignored file's bytes —
 * so ONE file the OS will not read, anywhere in the repository and referenced by
 * nothing, makes git refuse the whole snapshot. `getGitTreeSnapshot` answers
 * that with `null`, the same `null` as "not a repository", and the crawl that
 * needs it used to throw an uncoded "it is not a git repository" about a
 * directory that is one. `unreadableSnapshotRefusal` names the file instead.
 */

import { chmodSync, writeFileSync } from 'node:fs';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { isVatError } from '../../src/errors/vat-error.js';
import { gitTreeSnapshot, GIT_SNAPSHOT_UNREADABLE_CODE, unreadableSnapshotRefusal } from '../../src/git-snapshot.js';
import { safePath } from '../../src/path-utils.js';
import { CANNOT_DENY_READS } from '../../src/testing/platform-gates.js';
import { setupSyncTempDirSuite } from '../../src/testing/temp-dir.js';
import { createGitRepo } from '../test-helpers.js';

describe('unreadableSnapshotRefusal', () => {
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
      // The premise: git itself refuses the snapshot for this one file.
      expect(gitTreeSnapshot({ cwd: root })).toBeNull();

      const refusal = unreadableSnapshotRefusal(root);

      expect(isVatError(refusal, GIT_SNAPSHOT_UNREADABLE_CODE), String(refusal)).toBe(true);
      expect(refusal?.message).toContain('secret.txt');
      expect(refusal?.message).not.toContain('readme.md');
    } finally {
      chmodSync(secret, 0o644);
    }
  });

  it('has nothing to say about a repository whose files are all readable', () => {
    const root = createGitRepo(suite.getTempDir());
    writeFileSync(safePath.join(root, 'readme.md'), '# readable\n');

    expect(unreadableSnapshotRefusal(root)).toBeUndefined();
  });

  it('has nothing to say outside a repository', () => {
    expect(unreadableSnapshotRefusal(suite.getTempDir())).toBeUndefined();
  });
});
