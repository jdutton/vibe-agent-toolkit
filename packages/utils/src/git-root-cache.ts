/**
 * The module-level memo behind `gitFindRoot`, in its own leaf module.
 *
 * Two modules need it and they must not need each other:
 *
 * - `git-utils.ts` reads and writes it (it owns the walk).
 * - `project-utils.ts` clears it from `resetProjectRootCaches()`, so callers
 *   have ONE reset to remember rather than one per walk-up cache.
 *
 * Having `project-utils.ts` import `git-utils.ts` for that would drag `which`
 * and `node:child_process` into the `./project` entry, which exists precisely so
 * root discovery costs no third-party packages to reach. This file imports
 * nothing, so both sides can depend on it.
 *
 * Deliberately not re-exported from `index.ts` or any subpath: the memo is an
 * implementation detail of `gitFindRoot`, and a second public reset name is a
 * reset callers forget to call.
 */

/**
 * Answers "which git root governs files at or below this directory?" for every
 * directory a walk has climbed through.
 *
 * The answer is a property of the keyed directory alone — it does not depend on
 * where the walk that discovered it started — so entries are safe to share
 * across starting points. That sharing is the whole point: on a real `vat audit`
 * run the `.git` probe fired 89 times over 21 distinct directories, because
 * different files' walks re-climb the same ancestors.
 *
 * `null` is a stored value, not an absence: "known not to be in a repository"
 * is the answer that costs a walk all the way to the filesystem root, so it has
 * to be cacheable. Absence is `undefined`, which `Map.get` returns and this
 * module never stores.
 */
const gitRootCache = new Map<string, string | null>();

/**
 * Look up a memoized git root.
 *
 * @param dir - Resolved directory to look up
 * @returns The memoized answer (possibly `null`), or `undefined` if unknown
 */
export function lookupGitRoot(dir: string): string | null | undefined {
  return gitRootCache.get(dir);
}

/**
 * Record `gitRoot` as the answer for every directory a walk climbed through.
 *
 * @param climbed - Directories visited by the walk, deepest first
 * @param gitRoot - The answer they all share
 * @returns `gitRoot`, so a walk can `return rememberGitRoot(...)`
 */
export function rememberGitRoot(climbed: readonly string[], gitRoot: string | null): string | null {
  for (const dir of climbed) gitRootCache.set(dir, gitRoot);
  return gitRoot;
}

/**
 * Drop every memoized git root.
 *
 * Not called directly by application code — `resetProjectRootCaches()` calls it,
 * so one reset invalidates both walk-up caches. Necessary because a `.git`
 * directory can appear or vanish while the process lives (tests build fixtures
 * mid-run; a long-lived host re-enters `vat audit` between edits), and a stale
 * entry would outlive the change.
 */
export function resetGitRootCache(): void {
  gitRootCache.clear();
}
