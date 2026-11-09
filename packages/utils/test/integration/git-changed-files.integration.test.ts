/**
 * `gitChangedFiles` against a real repository: the merge base of the ref and HEAD against the
 * working tree, plus untracked files, restricted to a root that is a SUBDIRECTORY of the repository.
 *
 * HOME, XDG_CONFIG_HOME and CLAUDE_CONFIG_DIR point into the scratch directory, so the operator's
 * global git config (a `diff.renames = copies`, a `diff.relative`, a hooks path) cannot change
 * what this repository answers.
 */

import { renameSync, rmSync, writeFileSync } from 'node:fs';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { gitChangedFiles } from '../../src/git-changed-files.js';
import { runGit, runGitOrThrow } from '../../src/git-run.js';
import { mkdirSyncReal, safePath } from '../../src/path-utils.js';
import { tmpdirFoldsCase } from '../../src/testing/platform-gates.js';
import { setupSyncTempDirSuite } from '../../src/testing/temp-dir.js';

/** Enough content that git's rename detection pairs a moved file with its source. */
const BODY = 'line one\nline two\nline three\nline four\nline five\n';

/** Identity and signing for every commit the fixture makes, independent of the host's config. */
const COMMIT_CONFIG = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false'];

/** Write `content` at `relative` under `dir`, creating its parents. */
function put(dir: string, relative: string, content: string): void {
  const target = safePath.join(dir, relative);
  mkdirSyncReal(safePath.join(target, '..'), { recursive: true });
  writeFileSync(target, content);
}

/** Stage everything and commit it. */
function commitAll(repo: string, message: string): void {
  runGitOrThrow(['add', '-A'], { cwd: repo });
  runGitOrThrow([...COMMIT_CONFIG, 'commit', '-q', '-m', message], { cwd: repo });
}

/** The `(path, status)` pairs of an answer, which `changed_files` keys on. */
function keysOf(result: ReturnType<typeof gitChangedFiles>): string[] {
  return result.ok ? result.files.map((file) => `${file.path}:${file.status}`) : [];
}

describe('gitChangedFiles', () => {
  const suite = setupSyncTempDirSuite('vat-git-changed-files');
  let repo: string;
  let base: string;

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);

  beforeEach(() => {
    suite.beforeEach();
    const scratch = suite.getTempDir();
    const home = safePath.join(scratch, 'home');
    const tmp = safePath.join(scratch, 'tmp');
    mkdirSyncReal(home);
    mkdirSyncReal(tmp);
    vi.stubEnv('HOME', home);
    vi.stubEnv('XDG_CONFIG_HOME', home);
    vi.stubEnv('CLAUDE_CONFIG_DIR', safePath.join(home, '.claude'));
    vi.stubEnv('TMPDIR', tmp);

    repo = safePath.join(scratch, 'repo');
    mkdirSyncReal(repo);
    runGitOrThrow(['init', '-q', '-b', 'main'], { cwd: repo });
    const files = ['keep.md', 'edit.md', 'gone.md', 'old.md', 'leaving.md', 'late.md', 'moved.md'];
    for (const relative of [...files.map((file) => `site/${file}`), 'outside.md']) {
      put(repo, relative, `${relative}\n${BODY}`);
    }
    commitAll(repo, 'base');
    base = runGitOrThrow(['rev-parse', 'HEAD'], { cwd: repo });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reports added, modified, deleted, renamed and untracked files under a subdirectory root', () => {
    put(repo, 'site/edit.md', 'changed\n');
    rmSync(safePath.join(repo, 'site/gone.md'));
    renameSync(safePath.join(repo, 'site/old.md'), safePath.join(repo, 'site/new.md'));
    renameSync(safePath.join(repo, 'site/leaving.md'), safePath.join(repo, 'left.md'));
    put(repo, 'site/staged.md', 'staged\n');
    put(repo, 'outside.md', 'changed outside the root\n');
    runGitOrThrow(['add', '-A'], { cwd: repo });
    // After the add: the WORKING TREE is compared, so an unstaged edit and an un-added move count.
    put(repo, 'site/late.md', 'edited after staging\n');
    renameSync(safePath.join(repo, 'site/moved.md'), safePath.join(repo, 'site/moved-to.md'));
    put(repo, 'site/untracked.md', 'untracked\n');
    put(repo, 'site/.gitignore', 'ignored.md\n');
    put(repo, 'site/ignored.md', 'ignored\n');
    // A nested repository's contents are its own files, not this tree's.
    mkdirSyncReal(safePath.join(repo, 'site/nested'));
    runGitOrThrow(['init', '-q'], { cwd: safePath.join(repo, 'site/nested') });
    put(repo, 'site/nested/inner.md', 'inner\n');

    const result = gitChangedFiles({ root: safePath.join(repo, 'site'), base: 'HEAD' });

    expect(result).toStrictEqual({
      ok: true,
      baseCommit: base,
      files: [
        { path: '.gitignore', status: 'added', oldPath: null, similarity: null },
        { path: 'edit.md', status: 'modified', oldPath: null, similarity: null },
        { path: 'gone.md', status: 'deleted', oldPath: null, similarity: null },
        { path: 'late.md', status: 'modified', oldPath: null, similarity: null },
        // Renamed OUT of the root: a deletion, seen from inside it.
        { path: 'leaving.md', status: 'deleted', oldPath: null, similarity: null },
        // Moved without `git add`: git pairs only paths the index knows, so deleted + added.
        { path: 'moved-to.md', status: 'added', oldPath: null, similarity: null },
        { path: 'moved.md', status: 'deleted', oldPath: null, similarity: null },
        { path: 'new.md', status: 'renamed', oldPath: 'old.md', similarity: 100 },
        { path: 'staged.md', status: 'added', oldPath: null, similarity: null },
        { path: 'untracked.md', status: 'added', oldPath: null, similarity: null },
      ],
    });
  });

  it('compares with the MERGE BASE, so a branch behind its base lists only its own changes', () => {
    runGitOrThrow(['switch', '-q', '-c', 'feature'], { cwd: repo });
    put(repo, 'site/edit.md', 'the feature\'s edit\n');
    commitAll(repo, 'feature');
    runGitOrThrow(['switch', '-q', 'main'], { cwd: repo });
    put(repo, 'site/main-only.md', 'main moved on\n');
    put(repo, 'site/keep.md', 'main edited this\n');
    commitAll(repo, 'main moves');
    runGitOrThrow(['switch', '-q', 'feature'], { cwd: repo });

    expect(gitChangedFiles({ root: repo, base: 'main' })).toStrictEqual({
      ok: true,
      baseCommit: base,
      files: [{ path: 'site/edit.md', status: 'modified', oldPath: null, similarity: null }],
    });
  });

  it('refuses a base that shares no history with HEAD, naming the fix', () => {
    runGitOrThrow(['switch', '-q', '--orphan', 'unrelated'], { cwd: repo });
    put(repo, 'other.md', 'unrelated\n');
    commitAll(repo, 'unrelated root');

    const result = gitChangedFiles({ root: repo, base: 'main' });

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.reason).toMatch(/"main" shares no history with HEAD.*fetch/s);
  });

  it('keeps (path, status) a key during a conflicted merge', () => {
    runGitOrThrow(['switch', '-q', '-c', 'side'], { cwd: repo });
    put(repo, 'site/edit.md', 'side\n');
    commitAll(repo, 'side');
    runGitOrThrow(['switch', '-q', 'main'], { cwd: repo });
    put(repo, 'site/edit.md', 'main\n');
    commitAll(repo, 'main');
    expect(runGit([...COMMIT_CONFIG, 'merge', 'side'], { cwd: repo }).ok).toBe(false);

    const result = gitChangedFiles({ root: repo, base: base });
    const keys = keysOf(result);

    expect(keys).toContain('site/edit.md:modified');
    expect(new Set(keys).size).toBe(keys.length);
  });

  it.each([['an empty ref', ''], ['a ref git would read as an option', '--output=x']])(
    'refuses %s before asking git',
    (_what, ref) => {
      const result = gitChangedFiles({ root: repo, base: ref });

      expect(result.ok).toBe(false);
      expect(result.ok ? '' : result.reason).toMatch(/is not a ref; pass a branch, tag or commit/);
    },
  );

  it('refuses a base that names no commit, naming the fix', () => {
    const result = gitChangedFiles({ root: repo, base: 'no-such-branch' });

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.reason).toMatch(/"no-such-branch" does not name a commit.*git fetch/s);
  });

  it('refuses a root that is not inside a git working tree', () => {
    const bare = safePath.join(suite.getTempDir(), 'not-a-repo');
    mkdirSyncReal(bare);

    const result = gitChangedFiles({ root: bare, base: 'HEAD' });

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.reason).toMatch(/is not inside a git working tree/);
  });

  // Skipped where the filesystem is case-sensitive: there `Site` and `site` are two directories.
  it.skipIf(!tmpdirFoldsCase())('answers, or refuses, from a root spelled in another case — never silently empty', () => {
    put(repo, 'site/edit.md', 'changed\n');

    const result = gitChangedFiles({ root: safePath.join(repo, 'SITE'), base: 'HEAD' });

    // git reports the root's prefix in the tracked spelling (macOS) or the typed one; either way
    // the edit is reported, or the run refuses naming both spellings.
    expect(result.ok ? result.files.map((file) => file.path) : result.reason).toEqual(
      result.ok ? ['edit.md'] : expect.stringMatching(/"SITE\/".*"site\/"/s),
    );
  });

  // Skipped where the filesystem is case-sensitive: a case-only rename on disk is a different directory there.
  it.skipIf(!tmpdirFoldsCase())('refuses a root whose on-disk case differs from the case git tracks it under', () => {
    renameSync(safePath.join(repo, 'site'), safePath.join(repo, 'tmp-case'));
    renameSync(safePath.join(repo, 'tmp-case'), safePath.join(repo, 'Site'));
    put(repo, 'Site/edit.md', 'changed\n');

    const result = gitChangedFiles({ root: safePath.join(repo, 'Site'), base: 'HEAD' });

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.reason).toMatch(/"Site\/".*"site\/"/s);
  });
});
