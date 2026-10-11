/**
 * Run one vat command and report the outcome a VERDICT is built from — never a
 * pass/fail judgement, because a verdict measures what vat DECIDED, including a
 * refusal.
 *
 * ## Why this is not `commands.ts`'s `completedExitCodes`
 *
 * `completedExitCodes` (`commands.ts:28-51`) answers a `perf`/`io` question:
 * "did this run take a duration worth trusting?" — narrow on purpose, because a
 * crash's wall-clock time is meaningless and must not enter a median. The
 * `verdict` facet asks a different question: "what did this run of vat REPORT?"
 * — and vat's own exit-code contract (`docs/architecture/cli.md`) already answers
 * it: `0` success, `1` validation findings, `2` system error. All three are
 * things vat decided to say, and a verdict facet that only accepted `0`/`1` would
 * be unable to compare two builds' behaviour on the exact input where one of them
 * refuses and the other used to. So {@link runOutcome} treats every exit code
 * alike — `2` included — as data: {@link RunOutcome.kind} is `'exited'` for any
 * of them. The one case this module refuses to call data is a process that never
 * produced an exit code at all (`kind: 'not-run'`): there is no vat verdict to
 * read from a command that did not start.
 */

import { runCommand } from './run.js';
import type { ResolvedInstrument, RunOptions } from './types.js';

/** What one run of a vat command produced, for a verdict to be read from. */
export type RunOutcome =
  | { readonly kind: 'exited'; readonly exitCode: number; readonly stdout: string; readonly stderr: string }
  | { readonly kind: 'not-run'; readonly spawnError: string; readonly stdout: string; readonly stderr: string };

/**
 * Run one vat command and classify what happened — never which exit codes
 * "count"; see this module's docstring.
 *
 * @param instrument - Which vat to run
 * @param args - The vat subcommand and its arguments
 * @param options - Working directory, arm environment, and an optional timeout
 * @returns `exited` with whatever exit code vat produced, or `not-run` with the
 *   spawn error when the process never got that far
 */
export function runOutcome(
  instrument: ResolvedInstrument,
  args: readonly string[],
  options: RunOptions,
): RunOutcome {
  const result = runCommand(instrument, args, options);
  if (result.exitCode === null) {
    return {
      kind: 'not-run',
      // classifyExit (run.ts) always sets spawnError alongside a null exitCode;
      // the fallback exists only so this reader never NEEDS that invariant.
      spawnError: result.spawnError ?? 'process produced no exit code',
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }
  return { kind: 'exited', exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}
