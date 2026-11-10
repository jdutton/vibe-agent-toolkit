/**
 * The one classifier for "git gave no answer for this root": a git binary missing from PATH is
 * its own cause, coded apart from "not a repository, or unreadable", so no caller can blame the
 * repository for a git that never ran.
 */

import { describe, expect, it } from 'vitest';

import { isVatError } from '../src/errors/vat-error.js';
import {
  GIT_NO_ANSWER_CODE,
  GIT_NOT_FOUND_CODE,
  GIT_NOT_FOUND_REMEDY,
  gitNoAnswerError,
  gitNoAnswerFor,
} from '../src/git-no-answer.js';

const ROOT = '/corpus/root';
const CONSEQUENCE = 'An empty population would read as an empty repository.';

/** Run `fn` with `PATH` emptied, so spawning `git` fails with ENOENT. */
function withoutGit<T>(fn: () => T): T {
  const saved = process.env['PATH'];
  try {
    process.env['PATH'] = '';
    return fn();
  } finally {
    process.env['PATH'] = saved;
  }
}

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
