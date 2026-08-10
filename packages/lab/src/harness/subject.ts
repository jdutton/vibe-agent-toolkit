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

import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';

import {
  crawlDirectorySync,
  fileContentHash,
  gitFindRoot,
  NEVER_CRAWL_GLOBS,
  safeExecResult,
  safePath,
  toForwardSlash,
} from '@vibe-agent-toolkit/utils';

import type { SubjectRef, SubjectVersion } from '../envelope/coordinate.js';

import type { ResolvedSubject, SubjectSource } from './types.js';

/**
 * A concrete commit, as git's plumbing prints it: 40 lowercase hex characters
 * for a SHA-1 repository, 64 for a SHA-256 one. The point of the check is not
 * the width — it is that a branch name, a tag, or the literal string `HEAD`
 * can never satisfy it, so nothing symbolic can reach the coordinate.
 */
const CONCRETE_COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * Separates the fields of one manifest record from the next.
 *
 * A NUL cannot occur in a path on any filesystem VAT supports, so the framing
 * is unambiguous: no two distinct file sets can produce the same byte stream by
 * a path that happens to contain the separator.
 */
const RECORD_SEPARATOR = Buffer.from([0]);

/**
 * Stands in for a file the population listed but that could not be read — a
 * tracked file deleted from the working tree, a dangling symlink, a permission
 * denial.
 *
 * Recorded rather than skipped, and rather than allowed to throw. Throwing
 * would make one of the commonest dirty states of all (`rm` a tracked file)
 * crash the run, since `git ls-files` still lists a deleted-but-tracked path.
 * Skipping would drop the path from the manifest, which reads as "this file
 * never existed" rather than "this file is gone". It cannot collide with a real
 * digest, which is always 64 hex characters.
 */
const UNREADABLE = '<unreadable>';

/**
 * What a fingerprint covers.
 *
 * The manifest construction is identical for both — same crawl, same sorted
 * order, same content hashing — and only the *population* differs, which is why
 * this is a parameter rather than a second algorithm.
 */
interface FingerprintScope {
  /**
   * Take git's own population (tracked, plus untracked-but-not-ignored) rather
   * than walking the filesystem.
   *
   * This is not an optimisation. It is what makes `workingFingerprint` cohere
   * with `dirty`: `git status --porcelain` decides dirtiness over exactly this
   * set, so a filesystem walk would fingerprint a *different* population than
   * the one the label was computed from. An edit to a gitignored build artifact
   * would then move the fingerprint — and so read as a moved subject — while
   * git, and therefore `dirty`, considered nothing to have changed at all.
   */
  readonly fromGit: boolean;
}

/** A plain folder: whatever is on disk, since git has no opinion about it. */
const PLAIN_FOLDER: FingerprintScope = { fromGit: false };

/** A working tree: exactly the files git judges dirtiness over. */
const GIT_POPULATION: FingerprintScope = { fromGit: true };

/**
 * What a fingerprint excludes, in both scopes.
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
 * Run one git plumbing command and return its exit status and decoded stdout.
 *
 * Goes through `safeExecResult` (PATH resolved once, no shell) rather than
 * spawning directly, and never throws: every caller here treats a non-zero exit
 * as information — "no commit yet", "detached HEAD" — rather than as a failure.
 *
 * @param args - Arguments after the `git` executable
 * @param cwd - Directory to run in
 * @returns The exit status (-1 when git could not be spawned) and stdout
 */
function runGit(args: readonly string[], cwd: string): { status: number; stdout: string } {
  const result = safeExecResult('git', [...args], { cwd, encoding: 'utf8' });
  const stdout = typeof result.stdout === 'string' ? result.stdout : result.stdout.toString('utf8');
  return { status: result.status, stdout };
}

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
 * Does the working tree carry changes the commit does not describe?
 *
 * **Judged repository-wide**, matching the commit being stamped: HEAD is a
 * repository-wide fact, so the label qualifying it has to be one too.
 * Untracked-but-not-ignored files count — they are content the instrument can
 * read, and a measurement that saw them is not reproducible from HEAD either.
 *
 * A `git status` that cannot be run is a hard error rather than an assumed
 * clean. That distinction is not pedantry: "we could not tell" and "there was
 * nothing to tell" would otherwise produce the same confident, wrong label, and
 * unlike a dirty tree there is nothing the caller can do to make the answer
 * meaningful.
 *
 * @param cwd - A directory inside the working tree
 * @param root - Repository root, for the message
 * @returns True when the tree has uncommitted changes
 * @throws {Error} When git cannot report the status
 */
function hasUncommittedChanges(cwd: string, root: string): boolean {
  const result = runGit(['status', '--porcelain'], cwd);
  if (result.status !== 0) {
    throw new Error(
      `Could not determine whether the subject at ${root} has uncommitted changes ` +
        `(git status exited ${result.status}). Refusing to guess: a coordinate that ` +
        'assumes "clean" because the check failed is a silent wrong answer.',
    );
  }

  return result.stdout.split('\n').some((line) => line.trim().length > 0);
}

/**
 * Order two relative paths deterministically, by UTF-16 code unit.
 *
 * Explicit rather than relying on the default sort so nothing locale-aware can
 * creep in: the fingerprint must be identical on every machine that hashes the
 * same tree.
 *
 * @param a - One relative path
 * @param b - The other
 * @returns Negative, zero, or positive per the comparator contract
 */
function compareByCodeUnit(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/**
 * The SHA-256 of a file's raw bytes, or {@link UNREADABLE}.
 *
 * @param absolutePath - File to hash
 * @returns A 64-character hex digest, or the unreadable sentinel
 */
function contentDigest(absolutePath: string): string {
  try {
    return fileContentHash(absolutePath);
  } catch {
    return UNREADABLE;
  }
}

/**
 * Fingerprint a set of files.
 *
 * The digest is taken over a manifest of one record per file — the file's
 * **relative path** (forward-slash, UTF-8 bytes) followed by the SHA-256 of its
 * **raw content bytes**, never a decoded string, so encoding and line endings
 * are covered rather than normalised away. Records are emitted in sorted path
 * order, which makes the result order-independent by construction rather than
 * by hoping the crawler is stable. The path is part of the record because
 * moving a file changes the tree even when no byte of content does.
 *
 * One algorithm, two populations — see {@link FingerprintScope}. The plain
 * folder scope deliberately never takes git's route (`respectGitignore: false`),
 * because it runs both for folders with no repository and for repositories with
 * an unborn HEAD, and letting a `.git` above the path change which files are
 * counted would make that fingerprint mean two different things.
 *
 * @param root - Absolute path to fingerprint
 * @param scope - Which population to cover
 * @returns The hex digest and the number of files it covers
 */
function fingerprintFiles(
  root: string,
  scope: FingerprintScope,
): { fingerprint: string; fileCount: number } {
  const relativePaths = crawlDirectorySync({
    baseDir: root,
    include: ['**/*'],
    exclude: [...FINGERPRINT_EXCLUDE],
    absolute: false,
    filesOnly: true,
    followSymlinks: false,
    respectGitignore: scope.fromGit,
    includeUntracked: scope.fromGit,
  }).map((relativePath) => toForwardSlash(relativePath));

  relativePaths.sort(compareByCodeUnit);

  const digest = createHash('sha256');
  for (const relativePath of relativePaths) {
    digest.update(relativePath, 'utf8');
    digest.update(RECORD_SEPARATOR);
    digest.update(contentDigest(safePath.join(root, relativePath)), 'utf8');
    digest.update(RECORD_SEPARATOR);
  }

  return { fingerprint: digest.digest('hex'), fileCount: relativePaths.length };
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
  const dirty = hasUncommittedChanges(root, gitRoot);

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
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- caller-supplied subject path; existence is exactly what is being checked
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
