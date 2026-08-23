/**
 * Building real git repositories for lab tests.
 *
 * Shared rather than copied, and the reason is not tidiness: two hand-written
 * copies of `commitAll` are free to disagree about whether the commit forces an
 * identity, and the copy that forgets fails only on a machine with no global
 * `user.email` — i.e. on CI, long after the test looked correct locally.
 *
 * The rules encoded here, each of which a copy has already got wrong somewhere:
 *
 * 1. **Fixtures fail loudly.** A silently failed `git commit` leaves an unborn
 *    HEAD, which turns a git-case test into a snapshot-case test that still
 *    passes some other assertion.
 * 2. **Identity and signing are forced per invocation**, because a fixture repo
 *    inherits the host's global config, and `commit.gpgsign=true` with no key
 *    fails to commit at all.
 * 3. **The branch is pinned** via `symbolic-ref` rather than `git init -b`, so
 *    it holds on every git version rather than only those new enough for the
 *    flag, and no assertion depends on the host's `init.defaultBranch`.
 */

import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { mkdirSyncReal, runGitOrThrow, safePath } from '@vibe-agent-toolkit/utils';

/** Pinned so an assertion does not depend on the host's `init.defaultBranch`. */
export const FIXTURE_BRANCH = 'lab-fixture';

/**
 * Identity and signing forced per-invocation. See this module's header, rule 2.
 */
export const COMMIT_CONFIG: readonly string[] = [
  '-c',
  'user.name=Lab Fixture',
  '-c',
  'user.email=lab@example.invalid',
  '-c',
  'commit.gpgsign=false',
];

/**
 * Run a git command in a fixture repo, throwing on any failure.
 *
 * ⚠️ **The root is checked before the command runs, and this is not defensive
 * padding.** `runGit`'s `cwd` is optional, and an absent one means "the
 * repository this process is standing in" — so a fixture root that arrives
 * `undefined` (a mistyped accessor on the temp-dir suite, a helper called before
 * `beforeEach`) does not fail: it silently runs the fixture's git IN THE
 * DEVELOPER'S OWN CHECKOUT. Measured, in this repo: `initRepo(undefined)`
 * reached `git symbolic-ref HEAD refs/heads/lab-fixture` against the working
 * worktree and detached it from its branch, which then surfaced three files
 * away as an unrelated-looking `rev-parse HEAD` failure.
 *
 * Tests are not typechecked here, so the type annotation catches none of this.
 * The runtime check is the only thing standing between a fixture typo and a
 * developer's uncommitted work.
 *
 * @param args - Arguments after the `git` executable
 * @param cwd - Fixture directory to run in; must be a real path
 * @throws {Error} When `cwd` is missing, so the command cannot escape to the cwd
 */
export function git(args: readonly string[], cwd: string): void {
  if (typeof cwd !== 'string' || cwd.length === 0) {
    throw new TypeError(
      `git-fixtures: refusing to run 'git ${args.join(' ')}' with no fixture root. ` +
        'Without one it would run in the developer\'s own repository — check that the ' +
        'temp-dir suite is wired to beforeEach and that the root came from getTempDir().',
    );
  }
  runGitOrThrow([...args], { cwd });
}

/**
 * Write a file inside a fixture, creating parent directories.
 *
 * @param root - Fixture root
 * @param relativePath - Forward-slash path under the root
 * @param content - File content
 */
export function writeFixtureFile(root: string, relativePath: string, content: string): void {
  const absolute = safePath.join(root, relativePath);
  mkdirSyncReal(dirname(absolute), { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixture path built from a suite's temp dir
  writeFileSync(absolute, content, 'utf8');
}

/**
 * `git init` on a known branch, with nothing committed yet.
 *
 * @param root - Fixture root
 */
export function initRepo(root: string): void {
  git(['init', '--quiet'], root);
  git(['symbolic-ref', 'HEAD', `refs/heads/${FIXTURE_BRANCH}`], root);
}

/**
 * Stage everything present and commit it.
 *
 * @param root - Fixture root
 * @param message - Commit message
 */
export function commitAll(root: string, message: string): void {
  git(['add', '--all'], root);
  git([...COMMIT_CONFIG, 'commit', '--no-verify', '--quiet', '-m', message], root);
}
