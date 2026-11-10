/**
 * `gitChangedFiles` against a real repository: the merge base of the ref and HEAD against one
 * snapshot of the working tree (untracked files included), restricted to a root that is a
 * SUBDIRECTORY of the repository.
 *
 * HOME, XDG_CONFIG_HOME and CLAUDE_CONFIG_DIR point into the scratch directory, so the operator's
 * global git config (a `diff.renames = copies`, a `diff.relative`, a hooks path) cannot change
 * what this repository answers.
 */

import { chmodSync, copyFileSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { compareCodeUnits } from '../../src/compare-code-units.js';
import { changedFilesUnderPrefix, gitChangedFiles, gitDidNotRun, parseNameStatusZ } from '../../src/git-changed-files.js';
import { runGit, runGitOrThrow } from '../../src/git-run.js';
import { mkdirSyncReal, safePath } from '../../src/path-utils.js';
import { createSymlink, symlinkCapability } from '../../src/test-helpers.js';
import { gitExecutable } from '../../src/testing/executables.js';
import { CANNOT_DENY_READS, tmpdirFoldsCase } from '../../src/testing/platform-gates.js';
import { setupSyncTempDirSuite } from '../../src/testing/temp-dir.js';
import { gitSpawnFailure } from '../test-helpers.js';

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
/**
 * The prefix git reports for `dir`: the spelling the run is judged against. A git that answers the
 * on-disk spelling (macOS's getcwd, Git for Windows' final-path lookup) makes a root typed in
 * another case an ordinary root; one that keeps the typed spelling makes it a case-spelling refusal.
 */
function gitPrefixOf(dir: string): string {
  return runGitOrThrow(['rev-parse', '--show-prefix'], { cwd: dir });
}

/**
 * Commit `files` under `Docs/`, then stage a case-only rename of the directory to `docs/` (through a
 * temporary name, as a folding filesystem needs). The rename is left uncommitted.
 *
 * @returns The commit holding the capitalised spelling
 */
function stageCaseOnlyDocsRename(repo: string, files: readonly string[]): string {
  for (const file of files) put(repo, `Docs/${file}`, `Docs/${file}\n${BODY}`);
  commitAll(repo, 'docs, capitalised');
  const capitalised = runGitOrThrow(['rev-parse', 'HEAD'], { cwd: repo });
  runGitOrThrow(['mv', 'Docs', 'tmp-case'], { cwd: repo });
  runGitOrThrow(['mv', 'tmp-case', 'docs'], { cwd: repo });
  return capitalised;
}

function keysOf(result: ReturnType<typeof gitChangedFiles>): string[] {
  return result.ok ? result.files.map((file) => `${file.path}:${file.status}`) : [];
}

/**
 * Put a `git` wrapper first on PATH: `prelude` (POSIX sh) runs first and may answer for git, else
 * the real git runs. POSIX only — the wrapper is a shell script.
 *
 * @returns The wrapper's directory
 */
function shimGit(scratch: string, prelude: string): string {
  const shim = safePath.join(scratch, 'shim-git');
  mkdirSyncReal(shim);
  writeFileSync(safePath.join(shim, 'git'), `#!/bin/sh\n${prelude}\nexec "${gitExecutable()}" "$@"\n`, { mode: 0o755 });
  vi.stubEnv('PATH', `${shim}${delimiter}${process.env['PATH'] ?? ''}`);
  return shim;
}

/** A git whose snapshot `add` (any index but the diagnostic's) fails saying nothing. */
const FAILING_SNAPSHOT = 'if [ "$1" = "add" ]; then case "$GIT_INDEX_FILE" in *vat-snapshot-probe-*) ;; *) exit 1;; esac; fi';

/** One documented `changed_files` refusal: its cause, and git's fault kind for it. */
interface DocumentedRefusal {
  readonly cause: string;
  readonly kind: string;
}

/** A refusal-table row: `| cause | \`kind\` | \`CODE\` |`. */
const REFUSAL_ROW = /^\| (.+) \| `(base|git-failed|repository)` \| `[A-Z_]+` \|$/;

/** The `changed_files` refusal table the CLI reference states (the skill states it identically: the CLI's lens test). */
const DOCUMENTED_REFUSALS: readonly DocumentedRefusal[] = readFileSync(
  safePath.join(import.meta.dirname, '..', '..', '..', 'cli', 'docs', 'resources.md'),
  'utf8',
).split('\n').flatMap((line) => {
  const match = REFUSAL_ROW.exec(line);
  return match === null ? [] : [{ cause: match[1] ?? '', kind: match[2] ?? '' }];
});

/** Run `produce` with `path` at `mode` (0 for a file, a mode without read for a directory), restoring 0o755 after. */
function withDenied(path: string, mode: number, produce: () => ReturnType<typeof gitChangedFiles>): ReturnType<typeof gitChangedFiles> {
  chmodSync(path, mode);
  try {
    return produce();
  } finally {
    chmodSync(path, 0o755);
  }
}

/** The refusal reason a shallow clone's cut-off history earns, its remedy included. */
const SHALLOW_REMEDY = /fetch-depth: 0.*between the merge base and the tips is complete.*git fetch --deepen=<n>/s;

/**
 * An origin whose `feature` merged a long `side` branch: `Y-Z-A` on main, `A-S1..S4` (side),
 * `A-F1`, the merge of S4, `F2` (feature), then `B` on main. Cloned at `depth`, the clone's
 * `feature` is checked out. Both live under `scratch`.
 */
function shallowClone(scratch: string, depth: number, extra: readonly string[] = []): string {
  const origin = safePath.join(scratch, 'origin');
  mkdirSyncReal(origin);
  runGitOrThrow(['init', '-q', '-b', 'main'], { cwd: origin });
  const commit = (name: string): void => {
    put(origin, `${name}.md`, `${name}\n`);
    commitAll(origin, name);
  };
  for (const name of ['Y', 'Z', 'A']) commit(name);
  runGitOrThrow(['switch', '-q', '-c', 'side'], { cwd: origin });
  for (const name of ['S1', 'S2', 'S3', 'S4']) commit(name);
  runGitOrThrow(['switch', '-q', '-c', 'feature', 'main'], { cwd: origin });
  commit('F1');
  runGitOrThrow([...COMMIT_CONFIG, 'merge', '-q', '--no-edit', 'side'], { cwd: origin });
  commit('F2');
  runGitOrThrow(['switch', '-q', 'main'], { cwd: origin });
  runGitOrThrow(['branch', '-q', '-D', 'side'], { cwd: origin });
  commit('B');
  const clone = safePath.join(scratch, 'clone');
  runGitOrThrow(['clone', '-q', '--depth', String(depth), ...extra, pathToFileURL(origin).href, clone], { cwd: scratch });
  runGitOrThrow(['switch', '-q', 'feature'], { cwd: clone });
  return clone;
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
    // A nested repository's contents are its own files, not this tree's: it is one gitlink row.
    const nested = safePath.join(repo, 'site/nested');
    mkdirSyncReal(nested);
    runGitOrThrow(['init', '-q', '-b', 'main'], { cwd: nested });
    put(nested, 'inner.md', 'inner\n');
    commitAll(nested, 'nested');

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
        // Moved without `git add`: the snapshot holds both sides, so git pairs them.
        { path: 'moved-to.md', status: 'renamed', oldPath: 'moved.md', similarity: 100 },
        { path: 'nested', status: 'added', oldPath: null, similarity: null },
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

  it('answers mid-merge: a conflicted (UU) file is one modified row, as it stands on disk with its markers', () => {
    runGitOrThrow(['switch', '-q', '-c', 'side'], { cwd: repo });
    put(repo, 'site/edit.md', 'side\n');
    commitAll(repo, 'side');
    runGitOrThrow(['switch', '-q', 'main'], { cwd: repo });
    put(repo, 'site/edit.md', 'main\n');
    commitAll(repo, 'main');
    expect(runGit([...COMMIT_CONFIG, 'merge', 'side'], { cwd: repo }).ok).toBe(false);

    expect(runGitOrThrow(['status', '--porcelain', '--', 'site/edit.md'], { cwd: repo })).toBe('UU site/edit.md');

    const result = gitChangedFiles({ root: repo, base: base });

    expect(result.ok).toBe(true);
    expect(keysOf(result)).toStrictEqual(['site/edit.md:modified']);
  });

  it.each([['an empty ref', ''], ['a ref git would read as an option', '--output=x']])(
    'refuses %s before asking git',
    (_what, ref) => {
      const result = gitChangedFiles({ root: repo, base: ref });

      expect(result.ok).toBe(false);
      expect(result.ok ? '' : result.reason).toMatch(/is not a ref; pass a branch, tag or commit/);
    },
  );

  it('refuses a bare repository and a directory inside .git: neither is a working tree', () => {
    const bareRepo = safePath.join(suite.getTempDir(), 'bare.git');
    mkdirSyncReal(bareRepo);
    runGitOrThrow(['init', '-q', '--bare'], { cwd: bareRepo });

    for (const root of [bareRepo, safePath.join(repo, '.git')]) {
      expect(gitChangedFiles({ root, base: 'HEAD' })).toMatchObject({
        ok: false,
        kind: 'repository',
        reason: expect.stringMatching(/is not inside a git working tree/),
      });
    }
  });

  // Skipped where the filesystem is case-sensitive: there `Site` and `site` are two directories.
  it.skipIf(!tmpdirFoldsCase())('answers, or refuses, from a root spelled in another case — never silently empty', () => {
    put(repo, 'site/edit.md', 'changed\n');

    const root = safePath.join(repo, 'SITE');
    const prefix = gitPrefixOf(root);
    const result = gitChangedFiles({ root, base: 'HEAD' });

    // Keyed on the prefix git reports, never on the platform: git spelling the root as on disk
    // reports the edit; git keeping the typed `SITE` refuses, naming both spellings.
    expect(['site/', 'SITE/']).toContain(prefix);
    if (prefix === 'site/') {
      expect(keysOf(result)).toStrictEqual(['edit.md:modified']);
    } else {
      expect(result).toMatchObject({ ok: false, kind: 'repository', reason: expect.stringMatching(/"SITE\/".*"site\/"/s) });
    }
  });

  // Skipped where the filesystem is case-sensitive: there `DRAFTS` and `drafts` are two directories.
  it.skipIf(!tmpdirFoldsCase())('answers, or refuses, from a never-committed root reached in another case', () => {
    put(repo, 'drafts/new.md', 'untracked only\n');

    const root = safePath.join(repo, 'DRAFTS');
    const prefix = gitPrefixOf(root);
    const result = gitChangedFiles({ root, base: 'HEAD' });

    // As above, keyed on the prefix git reports.
    expect(['drafts/', 'DRAFTS/']).toContain(prefix);
    if (prefix === 'drafts/') {
      expect(keysOf(result)).toStrictEqual(['new.md:added']);
    } else {
      expect(result).toMatchObject({ ok: false, kind: 'repository', reason: expect.stringMatching(/"DRAFTS\/".*"drafts\/"/s) });
    }
  });

  // Skipped where the filesystem is case-sensitive: there `Docs` and `docs` are two directories.
  it.skipIf(!tmpdirFoldsCase())('answers a case-only directory rename made before HEAD: its old side is history', () => {
    const capitalised = stageCaseOnlyDocsRename(repo, ['a.md']);
    commitAll(repo, 'docs, lower case');

    const result = gitChangedFiles({ root: safePath.join(repo, 'docs'), base: capitalised });

    expect(result.ok ? '' : result.reason).toBe('');
    // Renamed in from a spelling git keeps apart from the root: an addition, seen from inside it.
    expect(keysOf(result)).toStrictEqual(['a.md:added']);
  });

  // Skipped where the filesystem is case-sensitive: there `Docs` and `docs` are two directories.
  // A deletion under the old spelling already refuses; a rename OUT of it follows the same rule.
  it.skipIf(!tmpdirFoldsCase())('refuses a rename out of the root from its old spelling, as a deletion there would', () => {
    const capitalised = stageCaseOnlyDocsRename(repo, ['a.md', 'keep.md']);
    commitAll(repo, 'docs, lower case');
    mkdirSyncReal(safePath.join(repo, 'other'));
    runGitOrThrow(['mv', 'docs/a.md', 'other/a.md'], { cwd: repo });

    const result = gitChangedFiles({ root: safePath.join(repo, 'docs'), base: capitalised });

    expect(result).toMatchObject({ ok: false, kind: 'repository' });
    expect(result.ok ? '' : result.reason).toMatch(/"docs\/".*"Docs\/"/s);
  });

  it('reports no row for a file removed from the index but unchanged on disk (git rm --cached)', () => {
    runGitOrThrow(['rm', '-q', '--cached', 'site/keep.md'], { cwd: repo });

    expect(keysOf(gitChangedFiles({ root: repo, base: 'HEAD' }))).toStrictEqual([]);
  });

  it('reads a staged move whose source was recreated by its own content: the source per content, the target added', () => {
    runGitOrThrow(['mv', 'site/keep.md', 'site/kept.md'], { cwd: repo });
    put(repo, 'site/keep.md', 'a different file at the old name\n');

    expect(keysOf(gitChangedFiles({ root: repo, base: 'HEAD' }))).toStrictEqual([
      'site/keep.md:modified',
      'site/kept.md:added',
    ]);
  });

  it('reports a copied file as one added row: copies are never detected', () => {
    copyFileSync(safePath.join(repo, 'site/keep.md'), safePath.join(repo, 'site/copy.md'));

    expect(keysOf(gitChangedFiles({ root: repo, base: 'HEAD' }))).toStrictEqual(['site/copy.md:added']);
  });

  it.each([
    ['assume-unchanged', '--assume-unchanged', '--no-assume-unchanged'],
    ['skip-worktree', '--skip-worktree', '--no-skip-worktree'],
  ])('refuses a %s file on disk, naming it and the flag to clear', (flag, set, clear) => {
    runGitOrThrow(['update-index', set, '--', 'site/edit.md'], { cwd: repo });
    put(repo, 'site/edit.md', 'an edit git is told not to read\n');

    const result = gitChangedFiles({ root: safePath.join(repo, 'site'), base: 'HEAD' });

    expect(result).toMatchObject({ ok: false, kind: 'repository' });
    expect(result.ok ? '' : result.reason).toContain(`"edit.md" is marked ${flag}`);
    expect(result.ok ? '' : result.reason).toContain(`git update-index ${clear} -- "edit.md"`);
  });

  it.skipIf(process.platform === 'win32')('refuses a merge-base git fails, quoting it', () => {
    shimGit(suite.getTempDir(), 'if [ "$1" = "merge-base" ]; then echo "fatal: simulated merge-base fault" >&2; exit 128; fi');

    expect(gitChangedFiles({ root: repo, base: 'HEAD' })).toMatchObject({
      ok: false,
      kind: 'repository',
      reason: 'git merge-base failed. git said: fatal: simulated merge-base fault',
    });
  });

  it.skipIf(process.platform === 'win32')('refuses a shallow probe that answers neither true nor false as git\'s failure', () => {
    shimGit(suite.getTempDir(), 'if [ "$2" = "--is-shallow-repository" ]; then echo maybe; exit 0; fi');

    expect(gitChangedFiles({ root: repo, base: 'HEAD' })).toMatchObject({
      ok: false,
      kind: 'git-failed',
      reason: expect.stringMatching(/--is-shallow-repository answered "maybe", not true or false/),
    });
  });

  it('reads paths from the repository\'s top whatever diff.relative says, so a subdirectory root still answers', () => {
    runGitOrThrow(['config', 'diff.relative', 'true'], { cwd: repo });
    put(repo, 'site/edit.md', 'changed\n');

    expect(keysOf(gitChangedFiles({ root: safePath.join(repo, 'site'), base: 'HEAD' }))).toStrictEqual(['edit.md:modified']);
  });

  describe('a shallow clone', () => {
    it.skipIf(process.platform === 'win32')('finds the boundary list through an older git\'s relative --git-path answer', () => {
      const scratch = suite.getTempDir();
      const clone = shallowClone(scratch, 3, ['--no-single-branch']);
      runGitOrThrow(['fetch', '-q', '--deepen=1'], { cwd: clone });
      // A git before 2.31 does not know `--path-format`: it echoes the flag, then answers relative.
      shimGit(scratch, 'if [ "$2" = "--path-format=absolute" ]; then echo "--path-format=absolute"; echo ".git/shallow"; exit 0; fi');

      expect(gitChangedFiles({ root: clone, base: 'origin/main' })).toMatchObject({
        ok: false,
        kind: 'repository',
        reason: expect.stringMatching(/cut off from its parents/),
      });
    });

    it.skipIf(process.platform === 'win32')('refuses a boundary list that is absent while git still calls the clone shallow', () => {
      const scratch = suite.getTempDir();
      const clone = shallowClone(scratch, 3, ['--no-single-branch']);
      runGitOrThrow(['fetch', '-q', '--deepen=1'], { cwd: clone });
      const nowhere = safePath.join(scratch, 'no-such-shallow-file');
      shimGit(scratch, `if [ "$3" = "--git-path" ]; then echo "${nowhere}"; exit 0; fi`);

      expect(gitChangedFiles({ root: clone, base: 'origin/main' })).toMatchObject({
        ok: false,
        kind: 'repository',
        reason: expect.stringMatching(/boundary list is not at/),
      });
    });

    it.skipIf(process.platform === 'win32')('answers when the boundary list is gone because the clone was unshallowed in between', () => {
      const scratch = suite.getTempDir();
      const clone = shallowClone(scratch, 3, ['--no-single-branch']);
      runGitOrThrow(['fetch', '-q', '--deepen=4'], { cwd: clone });
      const nowhere = safePath.join(scratch, 'no-such-shallow-file');
      const asked = safePath.join(scratch, 'asked-shallow');
      // The first shallow probe is real (true); the boundary file is gone; the second says false.
      shimGit(
        scratch,
        `if [ "$3" = "--git-path" ]; then echo "${nowhere}"; exit 0; fi\n`
        + `if [ "$2" = "--is-shallow-repository" ]; then if [ -e "${asked}" ]; then echo false; exit 0; fi; : > "${asked}"; fi`,
      );

      expect(gitChangedFiles({ root: clone, base: 'origin/main' })).toMatchObject({ ok: true });
    });

    it('finds the boundary list through a root reached by a symlink or junction into the clone', ({ skip }) => {
      const capability = symlinkCapability();
      if (capability === null) {
        skip('this process cannot create symlinks');
        return;
      }
      const scratch = suite.getTempDir();
      const clone = shallowClone(scratch, 3, ['--no-single-branch']);
      runGitOrThrow(['fetch', '-q', '--deepen=1'], { cwd: clone });
      put(clone, 'sub/note.md', 'untracked\n');
      const link = safePath.join(scratch, 'linked-sub');
      createSymlink(capability, safePath.join(clone, 'sub'), link, 'junction');

      // A relative `../.git/shallow` resolved against the LINK names nothing, which read as "not shallow".
      expect(gitChangedFiles({ root: link, base: 'origin/main' })).toMatchObject({
        ok: false,
        kind: 'repository',
        reason: expect.stringMatching(/cut off from its parents/),
      });
    });

    it.skipIf(process.platform === 'win32')('refuses a boundary list it cannot read', () => {
      const scratch = suite.getTempDir();
      const clone = shallowClone(scratch, 3, ['--no-single-branch']);
      runGitOrThrow(['fetch', '-q', '--deepen=1'], { cwd: clone });
      // A directory where the list should be: a read that fails with EISDIR, not ENOENT.
      const directory = safePath.join(scratch, 'not-a-file');
      mkdirSyncReal(directory);
      shimGit(scratch, `if [ "$3" = "--git-path" ]; then echo "${directory}"; exit 0; fi`);

      expect(gitChangedFiles({ root: clone, base: 'origin/main' })).toMatchObject({
        ok: false,
        kind: 'repository',
        reason: expect.stringMatching(/boundary list .* cannot be read/),
      });
    });

    it('answers once deepened until no boundary lies between the merge base and either tip', () => {
      const clone = shallowClone(suite.getTempDir(), 3, ['--no-single-branch']);
      runGitOrThrow(['fetch', '-q', '--deepen=4'], { cwd: clone });

      expect(gitChangedFiles({ root: clone, base: 'origin/main' })).toMatchObject({
        ok: true,
        files: ['F1.md', 'F2.md', 'S1.md', 'S2.md', 'S3.md', 'S4.md'].map((path) => ({ path, status: 'added' })),
      });
    });

    it('answers when the merge base is itself the boundary: nothing can hide a nearer one', () => {
      // Depth 2 of feature alone: F2 and the merge, which is the boundary.
      const clone = shallowClone(suite.getTempDir(), 2, ['--single-branch', '--branch', 'feature']);

      expect(gitChangedFiles({ root: clone, base: 'HEAD~1' })).toMatchObject({
        ok: true,
        files: [{ path: 'F2.md', status: 'added' }],
      });
    });
  });

  it.skipIf(process.platform === 'win32')('asks git for no history walk in a repository that is not shallow, and takes ONE snapshot', () => {
    const log = safePath.join(suite.getTempDir(), 'calls.log');
    shimGit(suite.getTempDir(), `echo "$1" >> "${log}"`);
    put(repo, 'site/edit.md', 'changed\n');

    expect(keysOf(gitChangedFiles({ root: repo, base: 'HEAD' }))).toStrictEqual(['site/edit.md:modified']);
    const calls = readFileSync(log, 'utf8').split('\n');
    expect(calls).not.toContain('rev-list');
    expect(calls.filter((call) => call === 'write-tree')).toHaveLength(1);
  });

  it('lists a submodule whose commit moved as its directory, and ignores one that is only dirty', () => {
    const library = safePath.join(suite.getTempDir(), 'library');
    mkdirSyncReal(library);
    runGitOrThrow(['init', '-q', '-b', 'main'], { cwd: library });
    put(library, 'lib.md', 'lib\n');
    commitAll(library, 'library');
    runGitOrThrow(['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', library, 'site/lib'], { cwd: repo });
    commitAll(repo, 'add submodule');
    const sub = safePath.join(repo, 'site/lib');
    put(sub, 'lib.md', 'dirty, not committed\n');

    expect(keysOf(gitChangedFiles({ root: repo, base: 'HEAD' }))).toStrictEqual([]);

    commitAll(sub, 'the submodule moves');

    expect(keysOf(gitChangedFiles({ root: repo, base: 'HEAD' }))).toStrictEqual(['site/lib:modified']);
  });

  it.each([
    ['a ref that names no commit', 'no-such-branch', 'base'],
    ['an option-shaped ref', '--output=x', 'base'],
  ])('classes %s as the base\'s fault', (_what, ref, kind) => {
    expect(gitChangedFiles({ root: repo, base: ref })).toMatchObject({ ok: false, kind });
  });

  it('classes no working tree as the repository\'s fault, never the base\'s', () => {
    const bare = safePath.join(suite.getTempDir(), 'not-a-repo-either');
    mkdirSyncReal(bare);

    expect(gitChangedFiles({ root: bare, base: 'HEAD' })).toMatchObject({ ok: false, kind: 'repository' });
  });

  it.skipIf(process.platform === 'win32')('classes a base git cannot resolve as the repository\'s fault when git cannot resolve HEAD either', () => {
    // The first HEAD probe answers; every `rev-parse --verify` after it fails, as in a damaged repository.
    const seen = safePath.join(suite.getTempDir(), 'head-seen');
    shimGit(
      suite.getTempDir(),
      `if [ "$1" = "rev-parse" ] && [ "$2" = "--verify" ]; then if [ -e "${seen}" ]; then exit 1; fi; : > "${seen}"; fi`,
    );

    expect(gitChangedFiles({ root: repo, base: 'main' })).toMatchObject({
      ok: false,
      kind: 'repository',
      reason: expect.stringMatching(/cannot resolve HEAD either/),
    });
  });

  describe('a file git is told not to read', () => {
    // Its deletion would be missing from the answer; skip-worktree is exempt only in a sparse checkout.
    it.each(['assume-unchanged', 'skip-worktree'])('refuses a %s file that was deleted outside a sparse checkout', (flag) => {
      runGitOrThrow(['update-index', `--${flag}`, '--', 'site/edit.md'], { cwd: repo });
      rmSync(safePath.join(repo, 'site/edit.md'));

      expect(gitChangedFiles({ root: repo, base: 'HEAD' })).toMatchObject({
        ok: false,
        kind: 'repository',
        reason: expect.stringContaining(`"site/edit.md" is marked ${flag}`),
      });
    });

    it('answers a sparse checkout, whose skip-worktree files are absent from disk by design', () => {
      // Non-cone, so the top-level `outside.md` is left out and removed from disk.
      runGitOrThrow(['sparse-checkout', 'set', '--no-cone', '/site/'], { cwd: repo });
      expect(runGitOrThrow(['ls-files', '-v', '--', 'outside.md'], { cwd: repo })).toBe('S outside.md');
      put(repo, 'site/edit.md', 'changed\n');

      const result = gitChangedFiles({ root: repo, base: 'HEAD' });

      expect(result.ok).toBe(true);
      expect(keysOf(result)).toStrictEqual(['site/edit.md:modified']);
    });

    it('names both flags, and clears both, for a file marked assume-unchanged AND skip-worktree', () => {
      // Two calls: one `update-index` given both mark options applies only the last.
      runGitOrThrow(['update-index', '--skip-worktree', '--', 'site/edit.md'], { cwd: repo });
      runGitOrThrow(['update-index', '--assume-unchanged', '--', 'site/edit.md'], { cwd: repo });
      expect(runGitOrThrow(['ls-files', '-v', '--', 'site/edit.md'], { cwd: repo })).toBe('s site/edit.md');

      const result = gitChangedFiles({ root: repo, base: 'HEAD' });

      expect(result).toMatchObject({ ok: false, kind: 'repository' });
      expect(result.ok ? '' : result.reason).toContain('is marked skip-worktree and assume-unchanged');
      expect(result.ok ? '' : result.reason).toContain('git update-index --no-skip-worktree --no-assume-unchanged -- "site/edit.md"');
    });
  });

  // Skipped where the filesystem folds case: there `Docs` and `docs` are one directory.
  it.skipIf(tmpdirFoldsCase())('answers on a case-sensitive filesystem with sibling directories in another case', () => {
    put(repo, 'Docs/a.md', 'capitalised sibling\n');
    put(repo, 'docs/b.md', 'the root\n');
    commitAll(repo, 'two siblings');
    put(repo, 'Docs/a.md', 'changed in the sibling\n');
    put(repo, 'docs/b.md', 'changed in the root\n');

    expect(keysOf(gitChangedFiles({ root: safePath.join(repo, 'docs'), base: 'HEAD' }))).toStrictEqual(['b.md:modified']);
  });

  describe('a snapshot that fails', () => {
    it.skipIf(process.platform === 'win32')('refuses a failure the REAL diagnostic add states, which a dry run would not reach', () => {
      // A write fault: `--dry-run` writes no object, so it could never surface one.
      shimGit(
        suite.getTempDir(),
        `${FAILING_SNAPSHOT}\nif [ "$1" = "add" ] && [ "$3" != "--dry-run" ]; then echo "error: simulated object write failure" >&2; exit 128; fi`,
      );

      expect(gitChangedFiles({ root: repo, base: 'HEAD' })).toMatchObject({
        ok: false,
        kind: 'repository',
        reason: expect.stringMatching(/git refused to snapshot.*git said: error: simulated object write failure/s),
      });
    });
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
  /**
   * Every documented `changed_files` refusal, keyed to the REAL producer of its cause: a fixture
   * through `gitChangedFiles`, or — where no fixture can reach the cause — the unit seam that
   * decides it. Each asserts the documented fault kind and the cause's own words; the CLI's lens test
   * maps each kind to its code. A producer this host cannot run says so in its test name.
   */
  describe('the documented changed_files refusal table, each row from its real producer', () => {
    /** How one documented cause is produced, and the words its reason must carry. */
    interface Producer {
      readonly produce: () => { ok: boolean; kind?: string; reason?: string };
      readonly reason: RegExp;
      /** Why this host cannot produce it, or undefined when it can. */
      readonly cannot?: string | undefined;
    }

    const POSIX_SHIM = process.platform === 'win32' ? 'the git shim is a POSIX shell script' : undefined;
    const NO_DENIED_READS = CANNOT_DENY_READS ? 'this host cannot deny a read' : undefined;
    const NO_FOLDING = tmpdirFoldsCase() ? undefined : 'the temp filesystem does not fold case';

    const PRODUCERS: Readonly<Record<string, Producer>> = {
      'a ref that names no commit': {
        produce: () => gitChangedFiles({ root: repo, base: 'no-such-branch' }),
        reason: /"no-such-branch" does not name a commit.*git fetch/s,
      },
      'a ref that shares no history with `HEAD` in a full history (no merge base)': {
        produce: () => {
          runGitOrThrow(['switch', '-q', '--orphan', 'unrelated'], { cwd: repo });
          put(repo, 'other.md', 'unrelated\n');
          commitAll(repo, 'unrelated root');
          return gitChangedFiles({ root: repo, base: 'main' });
        },
        reason: /"main" shares no history with HEAD.*Pass a commit HEAD descends from/s,
      },
      'a ref with more than one merge base with `HEAD` (a criss-cross history: pass one of them)': {
        produce: () => {
          runGitOrThrow(['switch', '-q', '-c', 'left'], { cwd: repo });
          put(repo, 'left.md', 'left\n');
          commitAll(repo, 'left');
          runGitOrThrow(['switch', '-q', '-c', 'right', 'main'], { cwd: repo });
          put(repo, 'right.md', 'right\n');
          commitAll(repo, 'right');
          const right = runGitOrThrow(['rev-parse', 'HEAD'], { cwd: repo });
          // Criss-cross: each side merges the other's tip as it stood before either merge.
          runGitOrThrow([...COMMIT_CONFIG, 'merge', '-q', '--no-edit', 'left'], { cwd: repo });
          runGitOrThrow(['switch', '-q', 'left'], { cwd: repo });
          runGitOrThrow([...COMMIT_CONFIG, 'merge', '-q', '--no-edit', right], { cwd: repo });
          return gitChangedFiles({ root: repo, base: 'right' });
        },
        reason: /"right" has 2 merge bases with HEAD.*Pass one of them/s,
      },
      'git not found on `PATH`': {
        produce: () => {
          const empty = safePath.join(suite.getTempDir(), 'no-git-here');
          mkdirSyncReal(empty);
          vi.stubEnv('PATH', empty);
          return gitChangedFiles({ root: repo, base: 'HEAD' });
        },
        reason: /git was not found on PATH/,
      },
      // Unit seam: a git out of time cannot be produced on demand, so its classifier is driven directly.
      'git out of time, or more output than VAT reads (compare against a nearer base)': {
        produce: () => gitDidNotRun('diff-tree', gitSpawnFailure('ETIMEDOUT')) ?? { ok: true },
        reason: /did not finish within its time limit.*nearer base/s,
      },
      'a snapshot that fails for a cause git does not state, or whose second attempt times out': {
        produce: () => {
          shimGit(suite.getTempDir(), FAILING_SNAPSHOT);
          return gitChangedFiles({ root: repo, base: 'HEAD' });
        },
        reason: /cause is unknown/,
        cannot: POSIX_SHIM,
      },
      'not inside a git working tree (a bare repository and a directory inside `.git` included)': {
        produce: () => {
          const bare = safePath.join(suite.getTempDir(), 'not-a-repo');
          mkdirSyncReal(bare);
          return gitChangedFiles({ root: bare, base: 'HEAD' });
        },
        reason: /is not inside a git working tree/,
      },
      'no commits yet, or a git that cannot resolve `HEAD`': {
        produce: () => {
          const fresh = safePath.join(suite.getTempDir(), 'unborn');
          mkdirSyncReal(fresh);
          runGitOrThrow(['init', '-q', '-b', 'main'], { cwd: fresh });
          put(fresh, 'a.md', 'a\n');
          return gitChangedFiles({ root: fresh, base: 'main' });
        },
        reason: /no commits yet/,
      },
      'a shallow clone cut off before the base and `HEAD` meet (no merge base, shallow)': {
        produce: () => gitChangedFiles({ root: shallowClone(suite.getTempDir(), 1, ['--no-single-branch']), base: 'origin/main' }),
        reason: /shallow clone, and the history it holds is cut off before the base "origin\/main" and HEAD meet.*fetch-depth: 0/s,
      },
      'a shallow clone whose history may hide a nearer merge base (`fetch-depth: 0`, or `git fetch --deepen=<n>`)': {
        produce: () => {
          const clone = shallowClone(suite.getTempDir(), 3, ['--no-single-branch']);
          // Deepened once: the merge base A is now reachable, but S3 is still a boundary on the way to it.
          runGitOrThrow(['fetch', '-q', '--deepen=1'], { cwd: clone });
          return gitChangedFiles({ root: clone, base: 'origin/main' });
        },
        reason: SHALLOW_REMEDY,
      },
      'a partial clone missing blobs the diff needs (`git fetch --refetch`)': {
        produce: () => {
          const scratch = suite.getTempDir();
          const origin = safePath.join(scratch, 'promisor-origin');
          mkdirSyncReal(origin);
          runGitOrThrow(['init', '-q', '-b', 'main'], { cwd: origin });
          runGitOrThrow(['config', 'uploadpack.allowFilter', 'true'], { cwd: origin });
          put(origin, 'old.md', `old.md\n${BODY}`);
          commitAll(origin, 'old');
          rmSync(safePath.join(origin, 'old.md'));
          put(origin, 'keep.md', 'keep\n');
          commitAll(origin, 'old gone');
          const clone = safePath.join(scratch, 'promisor-clone');
          runGitOrThrow(['clone', '-q', '--filter=blob:none', pathToFileURL(origin).href, clone], { cwd: scratch });
          // The promisor is gone, so the base's never-fetched blob cannot arrive.
          rmSync(origin, { recursive: true, force: true });
          // Similar but not identical, so rename detection must read the old blob's bytes.
          put(clone, 'new.md', `new.md\n${BODY}`);
          return gitChangedFiles({ root: clone, base: 'HEAD~1' });
        },
        reason: /partial clone.*git fetch --refetch.*no --filter/s,
      },
      'a snapshot git refuses, its `fatal:`/`error:` quoted (a nested repository with no commit, an object it cannot write, a clean filter that fails)': {
        produce: () => {
          // `git add --all` refuses a nested repository with no commit checked out.
          mkdirSyncReal(safePath.join(repo, 'site/empty-nested'));
          runGitOrThrow(['init', '-q'], { cwd: safePath.join(repo, 'site/empty-nested') });
          put(repo, 'site/empty-nested/x.md', 'x\n');
          return gitChangedFiles({ root: repo, base: 'HEAD' });
        },
        reason: /git refused to snapshot.*git said: .*site\/empty-nested\/.*does not have a commit checked out/s,
      },
      'an untracked file outside a sparse checkout\'s definition (add it to the definition, remove it, or ignore it)': {
        produce: () => {
          runGitOrThrow(['sparse-checkout', 'set', '--no-cone', '/site/'], { cwd: repo });
          put(repo, 'stray.md', 'outside the sparse definition\n');
          return gitChangedFiles({ root: repo, base: 'HEAD' });
        },
        reason: /"stray\.md".*sparse-checkout definition.*git sparse-checkout add.*remove.*\.gitignore/s,
      },
      // `git add --all` only WARNS on a directory it cannot open, and exits 0: its untracked files
      // would be missing from an answer that still succeeds.
      'a directory under the root git cannot list (fix its permissions, or ignore it)': {
        produce: () => {
          put(repo, 'site/locked/untracked.md', 'never seen\n');
          return withDenied(safePath.join(repo, 'site/locked'), 0o311, () => gitChangedFiles({ root: safePath.join(repo, 'site'), base: 'HEAD' }));
        },
        reason: /'locked'/,
        cannot: NO_DENIED_READS,
      },
      'a file under the root git cannot read': {
        produce: () => {
          put(repo, 'site/secret.md', 'nobody reads this\n');
          return withDenied(safePath.join(repo, 'site/secret.md'), 0o000, () => gitChangedFiles({ root: repo, base: 'HEAD' }));
        },
        reason: /will not let it read site\/secret\.md/,
        cannot: NO_DENIED_READS,
      },
      'a file on disk marked assume-unchanged or skip-worktree (`git update-index --no-assume-unchanged` / `--no-skip-worktree`)': {
        produce: () => {
          runGitOrThrow(['update-index', '--assume-unchanged', '--', 'site/edit.md'], { cwd: repo });
          return gitChangedFiles({ root: repo, base: 'HEAD' });
        },
        reason: /"site\/edit\.md" is marked assume-unchanged.*--no-assume-unchanged/s,
      },
      'a filesystem that folds case whose `core.ignorecase` is not true (`git config core.ignorecase true`)': {
        produce: () => {
          runGitOrThrow(['config', 'core.ignorecase', 'false'], { cwd: repo });
          return gitChangedFiles({ root: repo, base: 'HEAD' });
        },
        reason: /folds case.*git config core\.ignorecase true/s,
        cannot: NO_FOLDING,
      },
      'on such a filesystem, a changed path (a deletion, a rename\'s new side, or the old side of a rename out of the root) spelling the root in another case or Unicode normalisation': {
        produce: () => {
          // The BASE spells the root `Docs/`; one file is gone since, a deletion under that spelling.
          const capitalised = stageCaseOnlyDocsRename(repo, ['a.md', 'b.md']);
          rmSync(safePath.join(repo, 'docs/b.md'));
          commitAll(repo, 'docs, lower case, one file fewer');
          return gitChangedFiles({ root: safePath.join(repo, 'docs'), base: capitalised });
        },
        reason: /"docs\/".*"Docs\/"/s,
        cannot: NO_FOLDING,
      },
      // Unit seam: APFS refuses a name that is not UTF-8, so no fixture can hold one everywhere.
      'a path under the root that is not UTF-8': {
        produce: () => {
          const listing = parseNameStatusZ(Buffer.from([0x4D, 0, 0x61, 0xFF, 0x2E, 0x6D, 0x64, 0]));
          return listing.ok ? changedFilesUnderPrefix(listing.records, new Uint8Array()) : listing;
        },
        reason: /is not UTF-8, so VAT cannot name it/,
      },
      // Unit seam: a listing git would never write cannot be had from a real git.
      'a listing git returned that VAT cannot read': {
        produce: () => parseNameStatusZ(Buffer.from('X\0what.md\0', 'utf8')),
        reason: /git diff-tree --name-status -z wrote a listing VAT cannot read/,
      },
    };

    const rows = DOCUMENTED_REFUSALS.filter((row) => row.cause !== 'no `--base`');

    it('has one producer for every documented cause git decides, and a documented cause for every producer', () => {
      expect(rows.length).toBeGreaterThanOrEqual(19);
      expect(Object.keys(PRODUCERS).sort(compareCodeUnits)).toStrictEqual(rows.map((row) => row.cause).sort(compareCodeUnits));
    });

    it.for(rows.map((row) => {
      const cannot = PRODUCERS[row.cause]?.cannot;
      return [cannot === undefined ? row.cause : `${row.cause} (not produced on this host: ${cannot})`, row.cause, row.kind] as const;
    }))('produces "%s" as the documented fault kind', ([, cause, kind], { skip }) => {
      const producer = PRODUCERS[cause];
      if (producer === undefined) throw new Error(`no producer for "${cause}"`);
      if (producer.cannot !== undefined) skip(producer.cannot);

      const produced = producer.produce();

      expect(produced).toMatchObject({ ok: false, kind, reason: expect.stringMatching(producer.reason) });
    });
  });
});
