/* eslint-disable security/detect-non-literal-fs-filename -- controlled temp fixture tree */
/**
 * Every git helper that takes a caller-supplied path must survive the
 * environment a git hook exports into it.
 *
 * `vat resources validate` runs from `vibe-validate`'s `pre-commit`, so these
 * functions really do execute inside `git commit`. Measured against a real hook
 * on 2026-08-16: a **worktree's** pre-commit exports absolute `GIT_DIR` and
 * `GIT_INDEX_FILE` pointing into `<main>/.git/worktrees/<name>`, and asked about
 * an unrelated repository from there, `gitLsFiles` returned the files of the
 * repository *being committed*. This file pins the fix.
 *
 * The fixture is two repositories holding disjoint files, because that is the
 * only shape in which a misdirected answer looks different from a correct one.
 * A single repository would return the same list either way and prove nothing.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { gitLsFiles, isGitIgnored } from '../../src/git-utils.js';
import { mkdirSyncReal, normalizedTmpdir, safePath } from '../../src/path-utils.js';
import { createGitRepo } from '../test-helpers.js';

/** The variables git exports into a hook and that must never steer a child. */
const HOOK_ENV_KEYS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_PREFIX',
  'GIT_CONFIG_PARAMETERS',
] as const;

/** The file only the repository under test has. */
const OURS = 'docs/ours.md';

/** The file only the outer, committing repository has. */
const THEIRS = 'theirs.md';

/**
 * Point the environment at `repo`, exactly as a worktree's pre-commit hook does.
 *
 * @param repo - The repository standing in for the one being committed
 */
function enterHookOf(repo: string): void {
  process.env.GIT_DIR = safePath.join(repo, '.git');
  process.env.GIT_WORK_TREE = repo;
  process.env.GIT_INDEX_FILE = safePath.join(repo, '.git', 'index');
  process.env.GIT_PREFIX = '';
}

describe('git helpers under a hook environment', () => {
  let ours: string;
  let theirs: string;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const key of HOOK_ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }

    ours = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-hook-ours-'));
    theirs = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-hook-theirs-'));
    createGitRepo(ours);
    createGitRepo(theirs);

    mkdirSyncReal(safePath.join(ours, 'docs'), { recursive: true });
    writeFileSync(safePath.join(ours, OURS), 'ours\n');
    writeFileSync(safePath.join(theirs, THEIRS), 'theirs\n');
  });

  afterEach(() => {
    for (const key of HOOK_ENV_KEYS) {
      delete process.env[key];
      if (saved[key] !== undefined) process.env[key] = saved[key];
    }
    rmSync(ours, { recursive: true, force: true });
    rmSync(theirs, { recursive: true, force: true });
  });

  it('gitLsFiles describes the directory it was given, not the one being committed', () => {
    const clean = gitLsFiles({ cwd: ours, includeUntracked: true });
    expect(clean).toContain(OURS);

    enterHookOf(theirs);
    const hooked = gitLsFiles({ cwd: ours, includeUntracked: true });

    // The load-bearing half is the second assertion: an implementation that
    // followed the inherited GIT_DIR returns a well-formed list of the WRONG
    // repository's files, which nothing downstream can detect.
    expect(hooked).toContain(OURS);
    expect(hooked).not.toContain(THEIRS);
  });

  it('gitLsFiles honours a pathspec against the given directory under GIT_PREFIX', () => {
    enterHookOf(theirs);
    // GIT_PREFIX is prepended when git interprets a pathspec, so an inherited
    // value silently re-scopes this pattern.
    expect(gitLsFiles({ cwd: ours, patterns: ['docs/*.md'], includeUntracked: true }))
      .toContain(OURS);
  });

  it('isGitIgnored answers about the given repository, not the one being committed', () => {
    writeFileSync(safePath.join(ours, '.gitignore'), 'docs/\n');
    // `theirs` deliberately does NOT ignore anything, so a misdirected check
    // returns the opposite answer rather than the same one by luck.
    enterHookOf(theirs);

    expect(isGitIgnored(safePath.join(ours, OURS), ours)).toBe(true);
  });

  it('an injected core.excludesFile cannot change which paths are reported', () => {
    const excludes = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-hook-excl-'));
    try {
      // Kept OUTSIDE both repositories: an excludes file written inside one
      // would itself appear as an untracked path, and the fixture could no
      // longer tell "the config took effect" from "I added a file".
      const excludesFile = safePath.join(excludes, 'extra-excludes');
      writeFileSync(excludesFile, 'docs/\n');

      const before = gitLsFiles({ cwd: ours, includeUntracked: true });
      expect(before).toContain(OURS);

      // Exactly the shape git uses to carry `-c key=value` into a hook.
      process.env.GIT_CONFIG_PARAMETERS = `'core.excludesFile'='${excludesFile}'`;

      expect(gitLsFiles({ cwd: ours, includeUntracked: true })).toContain(OURS);
    } finally {
      rmSync(excludes, { recursive: true, force: true });
    }
  });
});
