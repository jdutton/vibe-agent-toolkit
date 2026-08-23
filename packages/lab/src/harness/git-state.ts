/**
 * What git says about a working tree — asked once, by both axes that need it.
 *
 * Axis B (the subject) and axis C (the instrument) each have to answer the same
 * question: *does this checkout carry changes its HEAD does not describe?* They
 * used to have one answer between them because only the subject asked. Two
 * hand-written copies would be free to disagree — one counting untracked files
 * and the other not, one treating a failed `git status` as clean and the other
 * as an error — and a single report would then carry a `dirty` label on its
 * subject and a `dirty` label on its instrument computed by two different
 * definitions of the word. A reader has no way to see that, and no way to
 * recover from it.
 *
 * So the definition lives here, once, and both axes import it.
 */

import { runGit as runGitSafely } from '@vibe-agent-toolkit/utils';

/** One git plumbing invocation's outcome. */
export interface GitOutcome {
  /** Exit status, or `-1` when git could not be spawned at all. */
  readonly status: number;
  /** Decoded stdout, whatever the status. */
  readonly stdout: string;
}

/**
 * Run one git plumbing command and return its exit status and decoded stdout.
 *
 * Goes through the `runGit()` chokepoint in utils, which never throws: callers
 * treat a non-zero exit as information — "no commit yet", "detached HEAD" —
 * rather than as a failure.
 *
 * `cwd` is a **caller-supplied** path — a subject or an instrument checkout,
 * never "the repository I happen to be in" — so the scrub `runGit` applies by
 * default is the behaviour this function needs. Without it, run from a worktree
 * pre-commit hook, `git status --porcelain` at `cwd` reports the *committing*
 * repository's status with exit 0; the `status !== 0` guard below cannot see
 * that, and `hasUncommittedChanges` stamps a confident dirty/clean label
 * belonging to a different tree.
 *
 * @param args - Arguments after the `git` executable
 * @param cwd - Directory to run in
 * @returns The exit status and stdout
 */
export function runGit(args: readonly string[], cwd: string): GitOutcome {
  const result = runGitSafely(args, { cwd });
  return { status: result.status, stdout: result.stdout };
}

/**
 * Does the working tree carry changes the commit does not describe?
 *
 * **Judged repository-wide**, matching the commit being stamped: HEAD is a
 * repository-wide fact, so the label qualifying it has to be one too.
 * Untracked-but-not-ignored files count — they are content that can be read, and
 * a measurement that saw them is not reproducible from HEAD either.
 *
 * A `git status` that cannot be run is a hard error rather than an assumed
 * clean. That distinction is not pedantry: "we could not tell" and "there was
 * nothing to tell" would otherwise produce the same confident, wrong label, and
 * unlike a dirty tree there is nothing the caller can do to make the answer
 * meaningful.
 *
 * ⚠️ REVIEW FINDING 2026-08-14 — WHAT THIS CANNOT SEE, for the instrument axis.
 * This samples the tree at RESOLVE time, not at BUILD time, and what an
 * instrument actually runs is `dist/`. Two live false negatives follow, both
 * stamping a confident `dirty: false` over a binary the commit does not
 * describe:
 *
 *   1. build from a dirty tree → revert → measure.
 *   2. build → `git checkout <other commit>` → measure WITHOUT rebuilding. The
 *      tree is clean at the new commit; `dist/` still holds the old one's bytes.
 *
 * (2) is not hypothetical here — it is the trap already recorded as
 * "stale dist in another checkout" — and `dist/` is GITIGNORED (`.gitignore:8`),
 * so `git status --porcelain` can never see it. The risk this adds is that the
 * flag reads as a provenance guarantee when it is only a working-tree
 * observation. A real guarantee needs a fingerprint of the BUILT output, which
 * `instrument.ts` deliberately declines for its own stated reasons — so the
 * honest fix may be narrowing what the label claims rather than widening what it
 * checks.
 *
 * @param cwd - A directory inside the working tree
 * @param what - What is being labelled, for the error message — e.g.
 *   `the subject at /path` or `the instrument checkout at /path`
 * @returns True when the tree has uncommitted changes
 * @throws {Error} When git cannot report the status
 */
export function hasUncommittedChanges(cwd: string, what: string): boolean {
  const result = runGit(['status', '--porcelain'], cwd);
  if (result.status !== 0) {
    throw new Error(
      `Could not determine whether ${what} has uncommitted changes ` +
        `(git status exited ${String(result.status)}). Refusing to guess: a coordinate that ` +
        'assumes "clean" because the check failed is a silent wrong answer.',
    );
  }

  return result.stdout.split('\n').some((line) => line.trim().length > 0);
}

/**
 * Every path git tracks in a working tree, or `null` when git could not say.
 *
 * The independent reference a population report is held against. `null` is the
 * whole point of the signature: a subject outside git, or a git that failed, has
 * to stay distinguishable from a subject git tracks nothing in, because a caller
 * that read the second as the first would report the entire enumerated
 * population as "paths git does not track".
 *
 * **`-z`, with the trim turned off.** git sorts by byte value and 0x20 sorts
 * below every printable character, so a tracked path beginning with a space is
 * listed FIRST — exactly where a trim reaches it. The trimmed reading hands back
 * a path that does not exist, and every membership test against it then reads as
 * "not tracked", which is a divergence this instrument would have reported as a
 * finding about vat. The newline form has the mirror problem: git *quotes* paths
 * containing unusual bytes, so a path would arrive wrapped in quotes and miss
 * for a different reason.
 *
 * ⚠️ **The paths come back relative to `cwd`, not to the repository root**, and
 * only files beneath it are listed. So a caller comparing these against a
 * population must pass the base that population states — never "the subject
 * directory" by habit, which is an ancestor or a descendant of it often enough
 * that the mismatch would render as a wholesale divergence.
 *
 * @param cwd - The directory the listing is taken from and relative to
 * @returns Tracked paths relative to `cwd`, or `null` when git declined to answer
 */
export function trackedPaths(cwd: string): ReadonlySet<string> | null {
  const result = runGitSafely(['ls-files', '-z'], { cwd, trim: false });
  if (!result.ok) return null;
  // A `-z` listing ends with a trailing NUL, so the final split is empty; an
  // empty listing is the empty string, which splits to one empty entry. Both are
  // handled by dropping empties rather than by trimming, which is the thing this
  // reading exists to avoid.
  return new Set(result.stdout.split('\0').filter((path) => path.length > 0));
}
