/**
 * The signals a process must not die of before it has cleaned up, the ONE way a handler for them is
 * installed ({@link handleTerminatingSignals}), and how the process then dies of the signal itself.
 *
 * 🚨 Every terminating-signal handler in VAT's product code goes through
 * {@link handleTerminatingSignals}; `local/no-raw-signal-listener` refuses a raw `process.on` /
 * `process.once` / `process.addListener` for a signal anywhere else. The class it closes: a handler
 * that removed itself on the first signal and started an ASYNCHRONOUS cleanup, so a second signal —
 * which a terminal Ctrl-C under the `vat` wrapper delivers (the terminal signals the whole
 * foreground group, and the wrapper forwards) — met the default disposition and killed the process
 * half-way through that cleanup, leaking the clone or the lock it was removing.
 */

/**
 * The signals that end a process by default disposition — `kill <pid>`, `kill -INT <pid>`,
 * `timeout(1)`, a CI runner stopping or cancelling a step, a closed terminal, Ctrl-C, `Ctrl-\`,
 * Ctrl-Break.
 *
 * SIGQUIT is here because its default disposition terminates exactly as the others do (plus a core
 * dump where the system allows one). SIGBREAK is Windows' Ctrl-Break, which Node delivers there and
 * which ends a process with no handler. Each exists on one platform only: a listener for the other
 * platform's registers an ordinary event that never fires, which is harmless — so ONE list serves
 * both. SIGKILL is not here because nothing can handle it.
 *
 * ⚠️ On Windows only SIGINT, SIGBREAK and SIGHUP are ever DELIVERED, and only as console events
 * (Ctrl-C, Ctrl-Break, the console closing) — which the console sends to EVERY process attached to
 * it. An outside kill there (`taskkill /F`, `process.kill(pid, <any>)`, `child.kill()`) is
 * `TerminateProcess`: no handler runs at all.
 */
export const TERMINATING_SIGNALS = ['SIGTERM', 'SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGBREAK'] as const;

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
 * Every listener this process still has for `signal` is removed first, so the raise reaches the
 * default disposition — a {@link handleTerminatingSignals} guard still swallowing repeats included.
 * This process is about to die of it, so nothing those listeners would do still matters.
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
  process.removeAllListeners(signal);
  if (process.platform !== 'win32') {
    process.kill(process.pid, signal);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RERAISE_GRACE_MS);
  }
  process.exit(fallbackExitCode);
}

/** One caller's stake in this process's terminating signals. */
interface Registration {
  readonly cleanup: (signal: TerminatingSignal) => unknown;
  readonly fallbackExitCode: number;
}

/** Every guard not yet released, in installation order. */
const registrations = new Set<Registration>();

/** The signal being acted on — set by the first one, and the reason a repeat is swallowed. */
let received: TerminatingSignal | undefined;

/** Whether `value` is a promise (or any thenable) to wait for. */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as PromiseLike<unknown> | undefined)?.then === 'function';
}

/**
 * Run one cleanup, turning a synchronous throw into a rejection so it cannot stop the others — or
 * the ending. A cleanup reports its own failures; this only makes sure the process still ends.
 */
function runCleanup(registration: Registration, signal: TerminatingSignal): unknown {
  try {
    return registration.cleanup(signal);
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

/** The one listener every guard shares, on every {@link TERMINATING_SIGNALS} member. */
function onTerminatingSignal(signal: TerminatingSignal): void {
  // A repeat while the cleanups run: swallowed, so it cannot cut them short.
  if (received !== undefined) return;
  const [first] = registrations;
  if (first === undefined) return;
  received = signal;
  const pending = [...registrations]
    .map((registration) => runCleanup(registration, signal))
    .filter((outcome) => isThenable(outcome));
  const end = (): void => {
    unlisten();
    registrations.clear();
    received = undefined;
    reRaiseSignal(signal, first.fallbackExitCode);
  };
  // Synchronous cleanups end the process synchronously: nothing else runs meanwhile, so nothing can
  // publish a verdict after the operator asked this process to stop.
  if (pending.length === 0) {
    end();
    return;
  }
  Promise.allSettled(pending).then(end, end);
}

function listen(): void {
  for (const signal of TERMINATING_SIGNALS) process.on(signal, onTerminatingSignal);
}

function unlisten(): void {
  for (const signal of TERMINATING_SIGNALS) process.off(signal, onTerminatingSignal);
}

/** What {@link handleTerminatingSignals} hands back. */
export interface TerminatingSignalGuard {
  /**
   * The guarded work is over without a signal: stop guarding it.
   *
   * Before any signal arrived, this removes the guard — and the process's listeners with the last
   * one. Once a signal HAS arrived it changes nothing: the process still ends of that signal when
   * every cleanup has settled, and repeats are still swallowed until then. A caller that must end
   * the process its own way meanwhile does so with {@link reRaiseSignal} or `process.exit`, both of
   * which pass every listener by.
   *
   * @returns True when the guard was removed; false when a signal is already ending the process
   */
  release(): boolean;
  /**
   * {@link release} for work that would go on to report or exit its own way: resolves once the
   * guard is removed — and NEVER settles when a signal is already ending the process, so that work
   * neither publishes nor exits under it. Call it only once this guard's own cleanup can no longer
   * be in progress (the caller has run or awaited it), so the ending it yields to is not waiting
   * on the caller.
   *
   * @returns A promise that resolves once the guard is removed
   */
  releaseOrAwaitEnding(): Promise<void>;
}

/**
 * Guard this process's terminating signals while `cleanup` has something to undo: on the FIRST
 * {@link TERMINATING_SIGNALS} member, run it — and every other live guard's — then die of that
 * signal.
 *
 * - **A repeat is swallowed** until every cleanup has settled. A terminal Ctrl-C under the `vat`
 *   wrapper arrives twice (the group's, and the wrapper's forward); the second must not meet the
 *   default disposition half-way through an asynchronous cleanup.
 * - **Synchronous or asynchronous.** A `cleanup` that returns a promise is awaited, whichever way it
 *   settles — it reports its own failures. When none returned one, the process ends synchronously,
 *   inside the signal's own turn.
 * - **The ending** is {@link reRaiseSignal}: on POSIX the process dies of the signal (128 + n); on
 *   Windows, or where the raise cannot kill it (PID 1), it exits `fallbackExitCode`.
 * - **Guards compose.** One listener serves every live guard, so two guards in one process both
 *   clean up before it ends; the first one installed decides `fallbackExitCode`.
 *
 * @param options - The guard
 * @param options.cleanup - What to undo before the process ends; given the signal
 * @param options.fallbackExitCode - The exit code where the signal cannot end the process
 * @returns The guard, to release once the guarded work is over
 */
export function handleTerminatingSignals(options: {
  cleanup: (signal: TerminatingSignal) => unknown;
  fallbackExitCode: number;
}): TerminatingSignalGuard {
  const registration: Registration = { cleanup: options.cleanup, fallbackExitCode: options.fallbackExitCode };
  if (registrations.size === 0 && received === undefined) listen();
  registrations.add(registration);
  const release = (): boolean => {
    if (received !== undefined) return false;
    if (registrations.delete(registration) && registrations.size === 0) unlisten();
    return true;
  };
  return {
    release,
    releaseOrAwaitEnding: () => (release() ? Promise.resolve() : new Promise<void>(() => {})),
  };
}
