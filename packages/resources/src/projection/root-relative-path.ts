/**
 * Containment over root-relative, forward-slashed corpus paths — the one place
 * the projection asks "is this path at or below that directory?".
 */

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
