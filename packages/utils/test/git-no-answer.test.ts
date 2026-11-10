/**
 * The one classifier for git's silence: a git binary missing from PATH is its own cause, coded apart
 * from "not a repository, or unreadable", so no caller can blame the repository for a git that never
 * ran — and a failed snapshot's cause is decided here, one code each, for the crawl and
 * `changed_files` alike. The unreadable-file cause needs a file the OS refuses, so it is
 * `test/integration/git-snapshot-unreadable.integration.test.ts`'s.
 */

import { describe, expect, it } from 'vitest';

import { isVatError } from '../src/errors/vat-error.js';
import {
  GIT_FAILED_CODE,
  GIT_NO_ANSWER_CODE,
  GIT_NOT_FOUND_CODE,
  GIT_NOT_FOUND_REMEDY,
  GIT_SNAPSHOT_OUTSIDE_SPARSE_CODE,
  GIT_SNAPSHOT_REFUSED_CODE,
  gitNoAnswerError,
  gitNoAnswerFor,
  gitRunFailureOf,
  gitSnapshotError,
  gitSnapshotFailureOf,
  snapshotAttemptCause,
} from '../src/git-no-answer.js';
import { gitTreeSnapshot, type GitSnapshotFailure } from '../src/git-snapshot.js';
import { normalizedTmpdir } from '../src/path-utils.js';

import { gitSpawnFailure, withoutGit } from './test-helpers.js';

const ROOT = '/corpus/root';
const CONSEQUENCE = 'An empty population would read as an empty repository.';

describe('gitNoAnswerFor', () => {
  it('names a git missing from PATH, and never blames the repository', () => {
    const answer = withoutGit(() => gitNoAnswerFor(ROOT));

    expect(answer.code).toBe(GIT_NOT_FOUND_CODE);
    expect(answer.reason).toContain('git was not found on PATH');
    expect(answer.reason).toContain(`"${ROOT}"`);
    expect(answer.reason).not.toMatch(/not a git repository/);
  });

  it('blames the repository when git runs', () => {
    const answer = gitNoAnswerFor(ROOT);

    expect(answer.code).toBe(GIT_NO_ANSWER_CODE);
    expect(answer.reason).toBe(`git did not answer for "${ROOT}" — it is not a git repository, or git could not read it`);
  });
});

describe('gitNoAnswerError', () => {
  it('is a VatError coded GIT_NOT_FOUND when git is missing, its message the reason then the consequence', () => {
    const error = withoutGit(() => gitNoAnswerError(ROOT, CONSEQUENCE));

    expect(isVatError(error, GIT_NOT_FOUND_CODE)).toBe(true);
    expect(error.message).toMatch(/^git was not found on PATH.*\. An empty population would read as an empty repository\.$/s);
  });

  it('is a VatError coded GIT_NO_ANSWER when git runs', () => {
    const error = gitNoAnswerError(ROOT, CONSEQUENCE);

    expect(isVatError(error, GIT_NO_ANSWER_CODE)).toBe(true);
    expect(error.message).toBe(
      `git did not answer for "${ROOT}" — it is not a git repository, or git could not read it. ${CONSEQUENCE}`,
    );
  });
});

describe('GIT_NOT_FOUND_REMEDY', () => {
  it('is the remedy the missing-binary reason carries, so the two cannot drift apart', () => {
    const { reason } = withoutGit(() => gitNoAnswerFor(ROOT));

    expect(GIT_NOT_FOUND_REMEDY).toBe('git was not found on PATH: install it, or put it on PATH.');
    expect(reason).toContain('install it, or put it on PATH');
  });
});

describe('gitRunFailureOf', () => {
  it.each([
    ['git is not on PATH', 'ENOENT', GIT_NOT_FOUND_CODE, /git was not found on PATH/],
    ['git ran out of time', 'ETIMEDOUT', GIT_FAILED_CODE, /did not finish within its time limit/],
    ['the output overran the buffer', 'ENOBUFS', GIT_FAILED_CODE, /more output than VAT reads/],
    ['the spawn failed otherwise', 'EACCES', GIT_FAILED_CODE, /Check that git runs here/],
  ])('codes it when %s, naming the command and the remedy', (_what, code, expected, remedy) => {
    // ENOENT is the binary's only when git is in fact missing, so every row runs without git on PATH.
    const cause = withoutGit(() => gitRunFailureOf('git diff-tree', ROOT, gitSpawnFailure(code)));

    expect(cause).toMatchObject({ code: expected, reason: expect.stringMatching(remedy) });
    expect(cause?.reason).toContain('git diff-tree');
  });

  it('codes an ENOENT with git on PATH as the directory\'s GIT_NO_ANSWER, naming it, never GIT_NOT_FOUND', () => {
    const cause = gitRunFailureOf('git diff-tree', ROOT, gitSpawnFailure('ENOENT'));

    expect(cause).toMatchObject({ code: GIT_NO_ANSWER_CODE, reason: expect.stringContaining(`"${ROOT}"`) });
    expect(cause?.reason).toContain('git diff-tree');
    expect(cause?.reason).not.toContain(GIT_NOT_FOUND_REMEDY);
  });

  it('is silent for a git that ran to an exit status', () => {
    expect(gitRunFailureOf('git diff-tree', ROOT, { ok: false, stderr: 'fatal: bad object' })).toBeUndefined();
  });
});

/** What `git add --all` writes, exit 1 and no `fatal:`, for an untracked file outside the sparse cone. */
const OUTSIDE_CONE = 'The following paths and/or pathspecs matched paths that exist\n'
  + 'outside of your sparse-checkout definition, so will not be\n'
  + 'updated in the index:\n'
  + 'out2.md\n'
  + 'hint: If you intend to update such entries, try one of the following:\n'
  + 'hint: * Use the --sparse option.\n';

describe('snapshotAttemptCause', () => {
  it('says git timed out only when the second attempt was seen to time out', () => {
    expect(snapshotAttemptCause(ROOT, gitSpawnFailure('ETIMEDOUT'), false)).toMatchObject({
      code: GIT_FAILED_CODE,
      reason: expect.stringMatching(/did not finish within its time limit/),
    });
  });

  it.each([
    ['the second attempt succeeded', { ok: true, stderr: '' }],
    ['git failed stating no refusal', { ok: false, stderr: 'warning: something odd' }],
  ])('calls the cause unknown, never a time-out, when %s', (_what, attempt) => {
    const cause = snapshotAttemptCause(ROOT, attempt, false);

    expect(cause).toMatchObject({ code: GIT_FAILED_CODE, reason: expect.stringMatching(/cause is unknown/) });
    expect(cause.reason).not.toMatch(/timed out|time limit/);
  });

  it.each([
    ['an object git cannot write', 'error: insufficient permission for adding an object to repository database .git/objects'],
    ['a clean filter that fails', 'error: external filter \'false\' failed 1\nfatal: site/a.md: clean filter \'broken\' failed'],
  ])('refuses %s as the tree\'s, quoting git', (_what, stderr) => {
    expect(snapshotAttemptCause(ROOT, { ok: false, stderr }, false)).toMatchObject({
      code: GIT_SNAPSHOT_REFUSED_CODE,
      reason: expect.stringMatching(/git refused to snapshot the working tree.*git said: (?:error|fatal): /s),
    });
  });

  it('refuses an untracked file outside a sparse checkout\'s definition as the tree\'s, naming it and the three fixes', () => {
    const cause = snapshotAttemptCause(ROOT, { ok: false, stderr: OUTSIDE_CONE }, true);

    expect(cause.code).toBe(GIT_SNAPSHOT_OUTSIDE_SPARSE_CODE);
    expect(cause.reason).toMatch(/^"out2\.md" lies outside/);
    expect(cause.reason).toMatch(/sparse-checkout definition.*git sparse-checkout add.*remove.*\.gitignore/s);
  });

  // git's list header not found: its own sentence is never named as a path.
  it('names no path when git wrote no list header, never git\'s own sentence', () => {
    const stderr = 'some paths lie outside of your sparse-checkout definition, so will not be\nstray.md';

    expect(snapshotAttemptCause(ROOT, { ok: false, stderr }, true).reason).toMatch(/^An untracked path lies outside/);
  });

  it('does not read git\'s sparse text as a sparse refusal where core.sparseCheckout is not true', () => {
    expect(snapshotAttemptCause(ROOT, { ok: false, stderr: OUTSIDE_CONE }, false).code).toBe(GIT_FAILED_CODE);
  });
});

/** The failure a snapshot of a directory in no repository returns. */
function noRepository(): GitSnapshotFailure {
  const outcome = gitTreeSnapshot({ cwd: normalizedTmpdir() });
  if (outcome.ok) throw new Error('expected the temp directory to be in no repository');
  return outcome;
}

describe('gitSnapshotFailureOf', () => {
  it('classes a directory in no repository as GIT_NO_ANSWER, the git error it hit carried', () => {
    const failure = noRepository();

    expect(failure.repositoryRoot).toBeNull();
    expect(failure.attempt.stderr).toMatch(/not a git repository/);
    expect(gitSnapshotFailureOf(failure)).toMatchObject({
      code: GIT_NO_ANSWER_CODE,
      reason: expect.stringContaining('it is not a git repository'),
    });
  });

  it('classes a git missing from PATH as GIT_NOT_FOUND, never as no repository', () => {
    const cause = withoutGit(() => {
      const failure = gitTreeSnapshot({ cwd: normalizedTmpdir() });
      if (failure.ok) throw new Error('expected no snapshot without git');
      return gitSnapshotFailureOf(failure);
    });

    expect(cause.code).toBe(GIT_NOT_FOUND_CODE);
    expect(cause.reason).toContain(GIT_NOT_FOUND_REMEDY);
    expect(cause.reason).not.toMatch(/not a git repository/);
  });

  it('throws as gitSnapshotError, coded by cause, its message the reason then the consequence', () => {
    const error = gitSnapshotError(noRepository(), CONSEQUENCE);

    expect(isVatError(error, GIT_NO_ANSWER_CODE)).toBe(true);
    expect(error.message).toMatch(/it is not a git repository.*\. An empty population would read as an empty repository\.$/s);
  });
});
