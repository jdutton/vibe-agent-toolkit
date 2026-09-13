/**
 * Resolving a command-line path argument into a target INSIDE a corpus root.
 *
 * Shared by every command that populates one tree and then answers questions
 * about positions in it — `vat claude context` and `vat claude budget` today.
 * They ask different questions and default differently when no path is named,
 * but "is this argument inside the tree I enumerated, and what is it called
 * there" is one rule. The predicate itself is `relativeEscapesRoot` from
 * `@vibe-agent-toolkit/utils` — the one lexical classifier every lane shares,
 * so the clause that only fails on Windows (a cross-drive `relative()` comes
 * back ABSOLUTE, not `..`-prefixed) is tested once, there, with the string
 * Windows really produces.
 */

import { relativeEscapesRoot, safePath } from '@vibe-agent-toolkit/utils';

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
  if (relativeEscapesRoot(relative)) {
    throw new Error(
      `${pathArg ?? process.cwd()} resolves outside the corpus root ${root}.`
      + ` ${commandName} answers only for paths inside the root it discovered —`
      + ' run it from within the project you mean to ask about.',
    );
  }
  return relative;
}
