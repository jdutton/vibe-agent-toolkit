/**
 * Axis A and axis B: **which project**, and **which version of it**.
 *
 * A subject is tracked on a moving ref on purpose — upstream moving *is* the
 * signal a survey exists to see. Pinning therefore happens here, at observation
 * time: whatever the caller named is resolved to a concrete commit (or, for a
 * folder that has no commits, to a content fingerprint) and stamped into the
 * report. The subject keeps moving; every report stays retrospectively pinned
 * and diffable. See the "Subjects move on purpose" section of the package
 * README.
 *
 * Two version kinds, and the choice between them is made from the filesystem,
 * never from the caller:
 *
 * - **`git`** — the path is inside a working tree with at least one commit. The
 *   commit is always the resolved 40-character SHA, never the branch name that
 *   named it; the branch is recorded separately in `ref` so a report can say
 *   both "this exact tree" and "we were following `main`".
 * - **`snapshot`** — no git above the path, or a repository with an unborn HEAD.
 *   {@link SubjectVersion} calls this "a snapshot of a folder that has *no
 *   commits*", which is the wider of the two readings and the right one: a
 *   freshly `git init`-ed directory has no commit to pin to either.
 *
 * **A dirty checkout is measured, not refused.** Refusing would forbid the most
 * common thing a developer does with a perf tool — edit, measure, watch the
 * number move — so a tree with uncommitted changes resolves normally, carries
 * `dirty: true`, and is pinned by a `workingFingerprint` alongside its real HEAD
 * commit. The commit is never silently made to stand for bytes it does not
 * describe; the label and the fingerprint are what keep the claim honest, and
 * the fingerprint is what keeps two runs over an unchanged dirty tree
 * comparable to each other.
 */

import { stat } from 'node:fs/promises';

import { safePath } from '@vibe-agent-toolkit/utils';
import { NEVER_CRAWL_GLOBS } from '@vibe-agent-toolkit/utils/crawl';
import {
  gitFindRoot,
} from '@vibe-agent-toolkit/utils/git';

import type { SubjectRef, SubjectVersion } from '../envelope/coordinate.js';

import { type FingerprintScope, fingerprintFiles } from './fingerprint.js';
import { hasUncommittedChanges, runGit } from './git-state.js';
import type { ResolvedSubject, SubjectSource } from './types.js';

/**
 * A concrete commit, as git's plumbing prints it: 40 lowercase hex characters
 * for a SHA-1 repository, 64 for a SHA-256 one. The point of the check is not
 * the width — it is that a branch name, a tag, or the literal string `HEAD`
 * can never satisfy it, so nothing symbolic can reach the coordinate.
 */
const CONCRETE_COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * What a subject fingerprint excludes, in both scopes.
 *
 * Only {@link NEVER_CRAWL_GLOBS} — dependencies, git internals, coverage and
 * test output, nested worktrees, turborepo caches. Those are not the subject's
 * content, and two of them (worktrees, `.turbo`) are *copies* of content
 * already counted elsewhere, so including them would let one byte change move
 * the fingerprint twice.
 *
 * Build output (`dist/`) is deliberately **not** excluded, unlike most VAT
 * crawls. A fingerprint is a claim that two runs saw the same tree; the
 * instrument can read built output, so a fingerprint blind to it would report
 * two materially different trees as the same version — the one wrong answer
 * this value exists to prevent.
 */
const FINGERPRINT_EXCLUDE: readonly string[] = NEVER_CRAWL_GLOBS;

/**
 * A plain folder: whatever is on disk, since git has no opinion about it.
 *
 * Never git's route, even under a `.git` — see {@link FingerprintScope.fromGit}.
 */
const PLAIN_FOLDER: FingerprintScope = { fromGit: false, exclude: FINGERPRINT_EXCLUDE };

/**
 * A working tree: exactly the files git judges dirtiness over.
 *
 * Git's own population, so `workingFingerprint` covers the set `git status
 * --porcelain` decided `dirty` over. A filesystem walk would fingerprint a
 * different population: an edit to a gitignored build artifact would then move
 * the fingerprint — and so read as a moved subject — while git, and therefore
 * `dirty`, considered nothing to have changed at all.
 */
const GIT_POPULATION: FingerprintScope = { fromGit: true, exclude: FINGERPRINT_EXCLUDE };

/**
 * The branch name HEAD points at, or `null` when HEAD is detached.
 *
 * Uses `symbolic-ref` rather than `rev-parse --abbrev-ref`, which reports the
 * literal string `HEAD` for a detached head and so cannot be told apart from a
 * branch that is actually named `HEAD`. Here the two answers are different exit
 * codes, and no string can be mistaken for the other case.
 *
 * @param cwd - A directory inside the working tree
 * @returns The short branch name, or `null` when detached
 */
function currentBranch(cwd: string): string | null {
  const result = runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd);
  if (result.status !== 0) return null;
  const name = result.stdout.trim();
  return name.length > 0 ? name : null;
}

/**
 * Resolve axis B for a git working tree whose HEAD already resolved.
 *
 * The working fingerprint is taken at the **repository root**, not at the
 * subject path, because the two facts it qualifies — `commit` and `dirty` — are
 * both repository-wide. A fingerprint scoped to a subdirectory would call two
 * runs the same version whenever the change that set `dirty` lay outside it.
 *
 * @param root - Absolute subject path, inside the working tree
 * @param gitRoot - The repository root
 * @param commit - The already-resolved concrete commit
 * @returns The pinned git version
 */
function gitVersion(root: string, gitRoot: string, commit: string): SubjectVersion {
  const dirty = hasUncommittedChanges(root, `the subject at ${gitRoot}`);

  return {
    kind: 'git',
    commit,
    ref: currentBranch(root),
    dirty,
    // Present exactly when dirty, which is the pairing SubjectVersionSchema
    // enforces: a clean tree is fully identified by its commit, so carrying a
    // fingerprint there would be a second identity for one state.
    workingFingerprint: dirty ? fingerprintFiles(gitRoot, GIT_POPULATION).fingerprint : null,
  };
}

/**
 * Resolve axis B for an absolute subject path.
 *
 * @param root - Absolute path to the subject
 * @returns The pinned version — a concrete commit, or a content fingerprint
 */
function resolveVersion(root: string): SubjectVersion {
  const gitRoot = gitFindRoot(root);
  if (gitRoot === null) {
    return { kind: 'snapshot', ...fingerprintFiles(root, PLAIN_FOLDER) };
  }

  const head = runGit(['rev-parse', 'HEAD'], root);
  const commit = head.stdout.trim();
  // An unborn HEAD (`git init` with nothing committed) exits non-zero here.
  // There is no commit to pin to, so this is the same situation as a plain
  // folder and gets the same answer, rather than a fabricated one.
  if (head.status !== 0 || !CONCRETE_COMMIT.test(commit)) {
    return { kind: 'snapshot', ...fingerprintFiles(root, PLAIN_FOLDER) };
  }

  return gitVersion(root, gitRoot, commit);
}

/**
 * Resolve a named project into the two coordinate axes it stamps.
 *
 * @param source - How the caller named the subject
 * @returns The absolute path to measure, axis A, and the pinned axis B
 * @throws {Error} When the path does not exist, is not a directory, or git
 *   cannot report whether the working tree is clean
 */
export async function resolveSubject(source: SubjectSource): Promise<ResolvedSubject> {
  const path = safePath.resolve(source.path);

  // Fail here, loudly, rather than letting a typo'd path become an empty
  // snapshot: a fingerprint over zero files is a perfectly well-formed
  // coordinate, and every report carrying it would be silently meaningless.
  const stats = await stat(path).catch(() => null);
  if (stats?.isDirectory() !== true) {
    throw new Error(`Subject path is not an existing directory: ${path} (named as "${source.path}")`);
  }

  // `source` keeps the string the caller used, not the resolved path: axis A
  // records how the subject was *named*, and two registries naming one checkout
  // differently are two subjects even though they measure the same bytes.
  const ref: SubjectRef = { id: source.id, source: source.path };

  return { path, ref, version: resolveVersion(path) };
}
