/**
 * How the `vat` wrapper (`vat.ts`) waits on the CLI it spawned, and ends the way the CLI ended.
 *
 * Its own module so the decisions are reachable by a unit test with a stand-in child: `vat.ts`
 * runs `main()` on import.
 */

import type { ChildProcess } from 'node:child_process';

import { ExitCode, exitCodeOfChild } from '@vibe-agent-toolkit/schema';
import {
  handleTerminatingSignals,
  isTerminatingSignal,
  killProcessTree,
  reRaiseSignal,
} from '@vibe-agent-toolkit/utils/process';

/**
 * Wait on the CLI child, and end this process the way it ended.
 *
 * ## 🚨 This wrapper is the `vat` an operator, a CI runner and `timeout(1)` start
 *
 * So `kill <pid>` lands HERE, not on the CLI. While the CLI runs, every terminating signal is
 * guarded (`handleTerminatingSignals`) so this process never dies before it: it waits for the
 * CLI's `exit`, then ends the same way — dying of the same signal when the CLI died of a
 * terminating one (re-raised; exit 2 where the raise cannot kill this process, and always on
 * Windows), otherwise with its exit code. A repeat within `REPEAT_SIGNAL_WINDOW_MS` is
 * swallowed (a terminal's group Ctrl-C reaches this process and the CLI both).
 *
 * - **A repeat after that window FORCES the ending**: the CLI is SIGKILLed — on Windows with its
 *   whole tree (`taskkill /T /F`) — and this process dies of the repeat at once. An operator whose
 *   first Ctrl-C or kill met a cleanup that hung can always end the run with a second.
 *
 * - **POSIX: the first signal is FORWARDED** to the CLI, because a signal sent to this pid alone
 *   reaches nothing else. A terminal Ctrl-C signals the whole foreground group, so the CLI then
 *   receives SIGINT twice — once from the terminal, once forwarded. That is safe only because
 *   every handler the CLI has goes through `handleTerminatingSignals`, which swallows a repeat
 *   that arrives with the first.
 * - **Windows: NOTHING is forwarded.** The only signals delivered there are console events
 *   (Ctrl-C, Ctrl-Break, the console closing), which the console already sends to every attached
 *   process, the CLI included; and `child.kill` there is `TerminateProcess`, which would PRE-EMPT
 *   the CLI's own cleanup (a progress directory, a clone, the MCP shutdown line). The guard still
 *   keeps this process waiting for the CLI, so it ends as the CLI ended.
 * - **A SIGKILL of this wrapper** runs none of this: the CLI (and anything it supervises) runs on
 *   to its own end, bounded by its own watchdog. The CLI's stdin is this process's, inherited — a
 *   pipe here would break every interactive command — so it never reads end-of-file.
 *
 * @param child - The spawned CLI
 */
export function superviseCli(child: ChildProcess): void {
  let cliEnded: () => void = () => undefined;
  const ended = new Promise<void>((resolve) => {
    cliEnded = resolve;
  });
  const guard = handleTerminatingSignals({
    fallbackExitCode: ExitCode.ERROR,
    cleanup: (signal, forced) => {
      // Not a group leader (a terminal's signals must reach it, and it reads the terminal): its pid.
      forced.addEventListener('abort', () => {
        killProcessTree(child, { groupLeader: false, throughChild: false });
      }, { once: true });
      if (process.platform !== 'win32') child.kill(signal);
      // Wait for the CLI: its `exit` below is what ends this process.
      return ended;
    },
  });

  // A child that never started has no status, which is not a verdict: exit 2. A failed FORWARD
  // (a signal the platform cannot send) also lands here, with the child running — it is ignored,
  // and the child's own `exit` still ends this process.
  child.on('error', () => {
    if (child.pid !== undefined) return;
    guard.release();
    process.exit(ExitCode.ERROR);
  });
  child.on('exit', (code, signal) => {
    cliEnded();
    guard.release();
    if (signal !== null && isTerminatingSignal(signal)) reRaiseSignal(signal, ExitCode.ERROR);
    // The child derived its code from its own document. Any other signal death has no status, and
    // a code off the contract (an older build's, Node's abort) is not a verdict the child
    // published, so neither is forwarded verbatim.
    process.exit(exitCodeOfChild(code));
  });
}
