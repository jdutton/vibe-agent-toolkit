/**
 * The fail-closed guard for user state in a TEST process.
 *
 * VAT keeps state under the user's home: the Claude directory (`CLAUDE_CONFIG_DIR`, else
 * `$HOME/.claude`), every other target's user-scope skills directory (`~/.codex/skills`, …), the
 * session store. A test that reaches one of them without redirecting it writes a developer's real
 * configuration, exit 0, with nothing in its output to say so — it has happened, twice, to a live
 * Claude config. So each place that resolves such a root passes it through
 * {@link requireTestScratch}, which throws when the test harness has named the one tree user state
 * may be in and the root is outside it.
 *
 * No user sets the variable: unset, the guard does nothing and costs one environment read.
 */

import { delimiter } from 'node:path';

import { relativeEscapesRoot, safePath } from './path-core.js';

/**
 * The variable a test process sets to the tree its user state may be in: the OS temp directory, in
 * each spelling it has (`path.delimiter`-separated — on macOS `/var/…` and the `/private/var/…` it
 * links to). The repo's shared vitest setup arms it in every tier, and every `vat` child a test
 * spawns inherits it.
 */
export const TEST_USER_STATE_UNDER = 'VAT_TEST_USER_STATE_UNDER';

/**
 * `root` — a directory of user state VAT is about to hand out — unless a test process named the tree
 * it must be in and it is outside that tree.
 *
 * Judged by spelling alone, with no filesystem call: the guard must not itself be a read the OS can
 * refuse (a fault-injection run would fail the guard instead of the verb under test).
 *
 * @param root - The resolved directory, absolute
 * @param what - What it is, for the message: `The Claude directory`
 * @returns `root`, unchanged
 * @throws Error naming the directory and the tree, when the variable is set and `root` is outside it
 */
export function requireTestScratch(root: string, what: string): string {
  const under = process.env[TEST_USER_STATE_UNDER]?.trim();
  if (under === undefined || under.length === 0) return root;
  const trees = under.split(delimiter).filter((tree) => tree.length > 0);
  if (trees.some((tree) => !relativeEscapesRoot(safePath.relative(tree, root)))) return root;
  throw new Error(
    `${what} resolves to ${root}, outside ${under}: refusing to resolve it in a test process `
      + `(${TEST_USER_STATE_UNDER} is set). Point the test at a temp directory first — HOME (and CLAUDE_CONFIG_DIR, blank or under it).`,
  );
}
