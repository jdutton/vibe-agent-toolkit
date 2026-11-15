/**
 * The signals a process must not die of before it has cleaned up, the ONE way a handler for them is
 * installed ({@link handleTerminatingSignals}), and how the process then dies of the signal itself.
 *
 * 🚨 Every terminating-signal handler in VAT's product code goes through
 * {@link handleTerminatingSignals}; `local/no-raw-signal-listener` refuses any other way of adding
 * or removing a listener for one (its README lists every shape it catches). The class it closes: a handler
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
 * How long after the first terminating signal a repeat is still the SAME interruption, and is
 * swallowed rather than acted on.
 *
 * A terminal's Ctrl-C under the `vat` wrapper arrives twice — the foreground group's, and the
 * wrapper's forward — milliseconds apart. A repeat later than this is an operator (or a supervisor)
 * asking again because the first did not end the process soon enough: it ends the process at once,
 * whatever cleanup is still running.
 */
export const REPEAT_SIGNAL_WINDOW_MS = 500;

/**
 * How long a re-raised signal is given to end this process before it ends itself instead.
 *
 * A process that SURVIVES its own re-raise is one whose default disposition for the signal does
 * nothing — PID 1 in a container is the common case — and it must still end.
 */
const RERAISE_GRACE_MS = 1000;

/** The longest interval a Node timer accepts: the hold below never fires, it only holds. */
const HOLD_INTERVAL_MS = 2 ** 31 - 1;

/**
 * End this process OF `signal`, as its default disposition would have — so a shell and a CI runner
 * read the status they expect (128 + n) — with an exit-code fallback.
 *
 * The {@link handleTerminatingSignals} listener is removed first, so the raise reaches the default
 * disposition rather than a guard still swallowing repeats. Only that listener: nothing else in VAT
 * installs one (`local/no-raw-signal-listener`), and a host's own — a test runner's — is not this
 * module's to strip. A process one of those keeps alive takes the fallback below.
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
  unlisten();
  if (process.platform !== 'win32') {
    process.kill(process.pid, signal);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RERAISE_GRACE_MS);
  }
  process.exit(fallbackExitCode);
}

/**
 * What a guard undoes before the process ends: given the signal, and an `AbortSignal` that aborts
 * — synchronously, just before the process ends — when a later repeat forces the ending while this
 * cleanup is still running. Most cleanups have nothing to do then; one that started something which
 * must not outlive this process (the `vat` wrapper's CLI) kills it there.
 */
export type TerminatingSignalCleanup = (signal: TerminatingSignal, forced: AbortSignal) => unknown;

/** One caller's stake in this process's terminating signals. */
interface Registration {
  readonly cleanup: TerminatingSignalCleanup;
  readonly fallbackExitCode: number;
}

/** Every guard not yet released, in installation order. */
const registrations = new Set<Registration>();

/** The ending a first signal started, while its cleanups run. */
interface Ending {
  readonly signal: TerminatingSignal;
  /** When the first signal arrived, on the monotonic clock. */
  readonly at: number;
  readonly fallbackExitCode: number;
  /** Aborted when a repeat forces the ending. */
  readonly forced: AbortController;
  /**
   * A ref'd timer, held while any cleanup is pending: a cleanup whose promise holds nothing open
   * would otherwise let the event loop empty, and Node exit 0 — a success status — instead of
   * dying of the signal.
   */
  readonly hold: NodeJS.Timeout;
  /** Cleanups still pending. */
  pending: number;
}

/** The ending in progress, if a signal has arrived — and the reason a repeat is not a new one. */
let ending: Ending | undefined;

/** Whether `value` is a promise (or any thenable) to wait for. */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as PromiseLike<unknown> | undefined)?.then === 'function';
}

/**
 * Run one cleanup inside `current`. A synchronous throw becomes a rejection, so it cannot stop the
 * others — or the ending: a cleanup reports its own failures, and this only makes sure the process
 * still ends. A promise it returns is waited for, whichever way it settles: the ending finishes
 * once the last one has.
 */
function joinEnding(current: Ending, cleanup: TerminatingSignalCleanup): void {
  let outcome: unknown;
  try {
    outcome = cleanup(current.signal, current.forced.signal);
  } catch (error) {
    outcome = Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
  if (!isThenable(outcome)) return;
  current.pending += 1;
  const settled = (): void => {
    current.pending -= 1;
    if (current.pending === 0 && ending === current) finishEnding(current, current.signal);
  };
  outcome.then(settled, settled);
}

/** End `current`'s ending: let go of everything this module holds, then die of `signal`. */
function finishEnding(current: Ending, signal: TerminatingSignal): void {
  clearInterval(current.hold);
  registrations.clear();
  ending = undefined;
  reRaiseSignal(signal, current.fallbackExitCode);
}

/** The one listener every guard shares, on every {@link TERMINATING_SIGNALS} member. */
function onTerminatingSignal(signal: TerminatingSignal): void {
  const current = ending;
  if (current !== undefined) {
    // The same interruption, delivered twice (a group Ctrl-C and the wrapper's forward): swallowed,
    // so it cannot cut the cleanups short.
    if (performance.now() - current.at < REPEAT_SIGNAL_WINDOW_MS) return;
    // Asked again: the cleanups are abandoned, and the process ends now, of the repeat.
    current.forced.abort();
    finishEnding(current, signal);
    return;
  }
  const [first] = registrations;
  if (first === undefined) return;
  const started: Ending = {
    signal,
    at: performance.now(),
    fallbackExitCode: first.fallbackExitCode,
    forced: new AbortController(),
    hold: setInterval(() => undefined, HOLD_INTERVAL_MS),
    pending: 0,
  };
  ending = started;
  for (const registration of registrations) joinEnding(started, registration.cleanup);
  // Synchronous cleanups end the process synchronously: nothing else runs meanwhile, so nothing can
  // publish a verdict after the operator asked this process to stop.
  if (started.pending === 0) finishEnding(started, signal);
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
   * every cleanup has settled (or a later repeat forces it). A caller that must end the process its
   * own way meanwhile does so with {@link reRaiseSignal} or `process.exit`, both of which pass every
   * guard by.
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
 * - **A repeat within {@link REPEAT_SIGNAL_WINDOW_MS} is swallowed.** A terminal Ctrl-C under the
 *   `vat` wrapper arrives twice (the group's, and the wrapper's forward); the second must not meet
 *   the default disposition half-way through an asynchronous cleanup.
 * - **A repeat after it ends the process at once**, of the repeat, the cleanups abandoned (each
 *   cleanup's `forced` signal aborts first): a second Ctrl-C or kill still ends a cleanup that hung.
 * - **Synchronous or asynchronous.** A `cleanup` that returns a promise is awaited, whichever way it
 *   settles — it reports its own failures — and a ref'd timer holds the process open meanwhile, so
 *   a promise that holds nothing open cannot let it exit 0. When none returned one, the process
 *   ends synchronously, inside the signal's own turn.
 * - **The ending** is {@link reRaiseSignal}: on POSIX the process dies of the signal (128 + n); on
 *   Windows, or where the raise cannot kill it (PID 1), it exits `fallbackExitCode`.
 * - **Guards compose.** One listener serves every live guard, so two guards in one process both
 *   clean up before it ends; the first one installed decides `fallbackExitCode`. A guard installed
 *   while an ending is in progress runs its cleanup at once, and the ending waits for it too.
 *
 * @param options - The guard
 * @param options.cleanup - What to undo before the process ends
 * @param options.fallbackExitCode - The exit code where the signal cannot end the process
 * @returns The guard, to release once the guarded work is over
 */
export function handleTerminatingSignals(options: {
  cleanup: TerminatingSignalCleanup;
  fallbackExitCode: number;
}): TerminatingSignalGuard {
  const registration: Registration = { cleanup: options.cleanup, fallbackExitCode: options.fallbackExitCode };
  if (ending === undefined) {
    if (registrations.size === 0) listen();
    registrations.add(registration);
  } else {
    joinEnding(ending, registration.cleanup);
  }
  const release = (): boolean => {
    if (ending !== undefined) return false;
    if (registrations.delete(registration) && registrations.size === 0) unlisten();
    return true;
  };
  return {
    release,
    releaseOrAwaitEnding: () => (release() ? Promise.resolve() : new Promise<void>(() => {})),
  };
}
