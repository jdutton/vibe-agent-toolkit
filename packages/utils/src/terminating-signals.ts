/**
 * The signals a process that owns a child must not die of alone, and how it then dies of one
 * itself.
 *
 * Shared by the two places that stand between an operator and a child process doing the work: the
 * `vat` wrapper (which forwards these to the CLI it spawned) and the checks supervisor (which takes
 * its child down on them). One list, so neither can cover a signal the other drops.
 */

/**
 * The signals that end a process by default disposition and reach its child only when sent to the
 * whole process GROUP — `kill <pid>`, `kill -INT <pid>`, `timeout(1)`, a CI runner stopping or
 * cancelling a step, a closed terminal, `Ctrl-\`.
 *
 * SIGQUIT is here because its default disposition terminates exactly as the others do (plus a core
 * dump where the system allows one). On Windows it does not exist: `process.on('SIGQUIT')` there
 * registers an ordinary event that never fires, which is harmless. SIGKILL is not here because
 * nothing can handle it.
 */
export const TERMINATING_SIGNALS = ['SIGTERM', 'SIGHUP', 'SIGINT', 'SIGQUIT'] as const;

/** One of {@link TERMINATING_SIGNALS}. */
export type TerminatingSignal = (typeof TERMINATING_SIGNALS)[number];

/**
 * Whether `signal` is one of {@link TERMINATING_SIGNALS}.
 *
 * @param signal - A signal name, as a child's `exit` reports it
 * @returns True for a terminating signal
 */
export function isTerminatingSignal(signal: string): signal is TerminatingSignal {
  return (TERMINATING_SIGNALS as readonly string[]).includes(signal);
}

/**
 * How long a re-raised signal is given to end this process before it ends itself instead.
 *
 * A process that SURVIVES its own re-raise is one whose default disposition for the signal does
 * nothing — PID 1 in a container is the common case — and it must still end.
 */
const RERAISE_GRACE_MS = 1000;

/**
 * End this process OF `signal`, as its default disposition would have — so a shell and a CI runner
 * read the status they expect (128 + n) — with an exit-code fallback.
 *
 * ⚠️ The caller must have removed every handler of its own for `signal` first, or the raise lands
 * on that handler instead of the default disposition.
 *
 * The wait is synchronous so nothing else runs meanwhile: output published after the operator asked
 * this process to end would read as the run's verdict. A process still here after
 * {@link RERAISE_GRACE_MS} survived its own raise (PID 1) and exits `fallbackExitCode`. Windows is
 * never sent the raise: it cannot SEND most of these signals, and the ones it can terminate without
 * a signal status to preserve — so on Windows this always exits `fallbackExitCode`.
 *
 * @param signal - The signal this process received
 * @param fallbackExitCode - The exit code when the raise cannot end this process
 */
export function reRaiseSignal(signal: NodeJS.Signals, fallbackExitCode: number): never {
  if (process.platform !== 'win32') {
    process.kill(process.pid, signal);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RERAISE_GRACE_MS);
  }
  process.exit(fallbackExitCode);
}
