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

import { dirname } from 'node:path';

import { canonicalPath, relativeEscapesRoot, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';

/**
 * The argument's root-relative spelling, or `undefined` when no ancestor of it
 * IS the root.
 *
 * 🪤 The root is discovered from `process.cwd()`, which the OS hands back
 * PHYSICAL — macOS `/tmp/x` arrives as `/private/tmp/x` — while an argument is
 * taken as typed. Comparing the two lexically refused `vat claude context
 * /tmp/x/sub` run from `/tmp/x` as "outside the corpus root /private/tmp/x".
 * So the PREFIX is compared canonically: the argument's ancestors are walked
 * from the top down, and the first whose canonical spelling is the root's
 * canonical spelling is where the root sits in what was typed.
 *
 * Only the prefix. The tail below the root stays as typed, because a query ON
 * an in-root symlinked path is a question about that name (answered `unknown`
 * — the lane realizes no symlink path), not about its target; canonicalizing
 * the whole argument would silently answer for a different file. Top-down, so
 * an in-root link pointing back at the root is not mistaken for the root.
 *
 * @param root - The discovered project root
 * @param target - The absolute, resolved argument
 */
function relativeThroughRoot(root: string, target: string): string | undefined {
  const canonicalRoot = canonicalPath(root);
  const ancestors: string[] = [];
  for (let current = toForwardSlash(target); ; current = toForwardSlash(dirname(current))) {
    ancestors.unshift(current);
    if (toForwardSlash(dirname(current)) === current) break;
  }
  const anchor = ancestors.find((ancestor) => canonicalPath(ancestor) === canonicalRoot);
  return anchor === undefined ? undefined : safePath.relative(anchor, target);
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
  const target = safePath.resolve(process.cwd(), pathArg ?? '.');
  const lexical = safePath.relative(root, target);
  // The lexical answer first: it is the common case and costs no syscall. Only
  // a spelling that escapes lexically is asked the filesystem's opinion.
  const relative = relativeEscapesRoot(lexical) ? relativeThroughRoot(root, target) : lexical;
  if (relative === undefined || relativeEscapesRoot(relative)) {
    throw new Error(
      `${pathArg ?? process.cwd()} resolves outside the corpus root ${root}.`
      + ` ${commandName} answers only for paths inside the root it discovered —`
      + ' run it from within the project you mean to ask about.',
    );
  }
  return relative;
}
