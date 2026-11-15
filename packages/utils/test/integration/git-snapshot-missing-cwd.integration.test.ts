/**
 * Node answers `ENOENT` for a spawn whose `cwd` does not exist exactly as for a binary missing from
 * PATH. The one classifier (`gitRunFailureOf`) must not read the first as the second: a snapshot of
 * a directory that does not exist, inside a real repository with git on PATH, is the directory's
 * `GIT_NO_ANSWER`, naming it — never `GIT_NOT_FOUND` with an "install git" remedy.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { GIT_NO_ANSWER_CODE, GIT_NOT_FOUND_REMEDY, gitSnapshotFailureOf } from '../../src/git-no-answer.js';
import { gitTreeSnapshot } from '../../src/git-snapshot.js';
import { safePath } from '../../src/path-utils.js';
import { setupSyncTempDirSuite } from '../../src/testing/temp-dir.js';
import { createGitRepo } from '../test-helpers.js';

describe('a snapshot of a directory that does not exist', () => {
  const suite = setupSyncTempDirSuite('git-snapshot-missing-cwd');
  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);
  beforeEach(suite.beforeEach);

  it('is GIT_NO_ANSWER naming the directory, never GIT_NOT_FOUND', () => {
    const missing = safePath.join(createGitRepo(suite.getTempDir()), 'no-such-dir');
    const failure = gitTreeSnapshot({ cwd: missing });
    if (failure.ok) throw new Error('expected no snapshot of a missing directory');

    const cause = gitSnapshotFailureOf(failure);

    expect(cause.code).toBe(GIT_NO_ANSWER_CODE);
    expect(cause.reason).toContain(missing);
    expect(cause.reason).not.toContain(GIT_NOT_FOUND_REMEDY);
  });
});
