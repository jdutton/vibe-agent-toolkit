/**
 * Root-relative, forward-slashed corpus paths: how an absolute path is spelled
 * relative to a root ({@link relativize}), and the one place the projection asks
 * "is this path at or below that directory?".
 */

import { safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';

/**
 * Render an absolute path relative to a root, forward-slashed.
 *
 * Every path a realization row or a snapshot prints goes through here. An
 * absolute path in a golden file makes the golden machine-specific and leaks
 * `$HOME`; both have bitten this repo before.
 *
 * @param absolutePath - Path to render
 * @param root - Root the path is rendered relative to
 * @returns Forward-slashed relative path (or the forward-slashed absolute path
 *   when the target lies outside the root, which is itself worth seeing)
 */
export function relativize(absolutePath: string, root: string): string {
  const rel = safePath.relative(root, absolutePath);
  return rel === '' ? '.' : toForwardSlash(rel);
}

/**
 * Is `queryDir` the directory `under`, or somewhere below it?
 *
 * ⚠️ An EMPTY `under` is the corpus ROOT, and everything is at or below it. The
 * nested-rule caller can never produce one — `nestedRuleParent` returns null
 * rather than `''` — so this branch exists for the ∃/∀ callers, where the root is
 * an ordinary query directory (`vat claude context .` at the top of a repo) and a
 * literal-free pattern has an empty prefix. Without it a root query enumerated
 * zero candidate files and every path-scoped rule silently vanished from the
 * answer: a confident empty, which is the one answer shape this lane refuses.
 *
 * @param queryDir - Root-relative directory of the query
 * @param under - Root-relative scoping directory, or `''` for the corpus root
 * @returns True when the query is in scope
 */
export function isAtOrBelow(queryDir: string, under: string): boolean {
  if (under === '') return true;
  // eslint-disable-next-line local/no-path-startswith -- `resource_realizations.path`-derived directories are forward-slashed and root-relative by `relativize()` before any consumer sees it, which is the precondition this rule enforces
  return queryDir === under || queryDir.startsWith(`${under}/`);
}
