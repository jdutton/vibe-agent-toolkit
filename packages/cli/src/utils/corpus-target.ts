/**
 * Resolving a command-line path argument into a target INSIDE a corpus root.
 *
 * Shared by every command that populates one tree and then answers questions
 * about positions in it — `vat claude context` and `vat claude budget` today.
 * They ask different questions and default differently when no path is named,
 * but "is this argument inside the tree I enumerated, and what is it called
 * there" is one rule, and a second copy of it would be free to drift on the one
 * clause that only fails where nobody looks (see {@link escapesCorpusRoot}).
 */

import { isAbsoluteAnyPlatform, safePath } from '@vibe-agent-toolkit/utils';

/**
 * Does a path already stated against the corpus root fall OUTSIDE it?
 *
 * Three spellings of "outside", not two, and the third is the one that could
 * only fail where nobody would see it. `safePath.relative` says "not under this
 * root" with a `..`-prefixed path in the ordinary case, but returns an ABSOLUTE
 * path when no relative route exists at all — which on Windows is exactly what a
 * different drive letter produces. Without the third test, `vat claude context
 * D:\elsewhere\doc.md` run from a `C:` repo passes the guard and answers `kind:
 * unknown`, indistinguishable from a typo inside the tree, which is the one
 * outcome {@link targetPathWithin}'s `@throws` claims to prevent. Its sibling
 * `escapesRoot` (`closure-extent.ts`) applies the same triple for the same
 * reason.
 *
 * ⛔ Exported so it can be TESTED. On POSIX `safePath.relative` between two
 * absolute paths never returns an absolute string, so the third clause is
 * unreachable through {@link targetPathWithin} on every machine a developer
 * runs — the branch has to be exercised directly or not at all, and "not at
 * all" is how it went missing in the first place.
 *
 * @param normalizedRelative - A forward-slashed path already stated against the
 *   corpus root
 * @returns True when the corpus root does not contain it
 */
export function escapesCorpusRoot(normalizedRelative: string): boolean {
  return normalizedRelative === '..'
    || normalizedRelative.startsWith('../')
    || isAbsoluteAnyPlatform(normalizedRelative);
}

/**
 * The root-relative path to query, refusing anything outside the corpus.
 *
 * @param root - The discovered project root
 * @param pathArg - The path argument, or undefined for the current directory
 * @param commandName - The command saying so, for the refusal's wording
 * @returns The root-relative, forward-slashed target. `''` is the corpus root
 * @throws When the argument resolves outside `root` — answering for it would
 *   mean querying a corpus this projection never enumerated, and a confident
 *   "nothing here" would be indistinguishable from a typo inside the tree
 */
export function targetPathWithin(
  root: string,
  pathArg: string | undefined,
  commandName: string,
): string {
  const relative = safePath.relative(root, safePath.resolve(process.cwd(), pathArg ?? '.'));
  if (escapesCorpusRoot(relative)) {
    throw new Error(
      `${pathArg ?? process.cwd()} resolves outside the corpus root ${root}.`
      + ` ${commandName} answers only for paths inside the root it discovered —`
      + ' run it from within the project you mean to ask about.',
    );
  }
  return relative;
}
