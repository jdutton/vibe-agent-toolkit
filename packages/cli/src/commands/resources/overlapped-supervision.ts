/**
 * The overlapped supervision scope: `vat validate`'s checks child spawned during the resources
 * phase, and read at its turn as if it had been spawned there.
 *
 * ## One scope from the spawn to the turn's final read
 *
 * {@link withProgressLog} opens BEFORE the progress directory is minted and closes only after the
 * turn has made its final read of `stderr.log` and closed its fd: one guard, one directory, one
 * file, across the whole gap. The run's ending is recorded when the child ends and published at
 * the turn, so a warm child that finished long before its turn still has its `stderr.log` when the
 * turn copies it, and no fd is open in the directory when it is removed (Windows refuses that).
 *
 * ## Stderr is held, then replayed
 *
 * The child's stderr is `stderr.log` (0600) in the progress directory: {@link superviseRun} hands
 * the child the write fd and closes its own copy, so the child and its grandchildren are its only
 * writers. At the turn the parent copies the file from offset 0 as raw bytes, follows it every
 * {@link FOLLOW_INTERVAL_MS} while the child runs, and makes one final read once the run has
 * settled (stdout closed, or the post-exit grace spent), then closes its read fd. Grandchild bytes
 * written after that read are not shown.
 *
 * ## Endings
 *
 * Completed, killed and abnormal endings are {@link superviseRun}'s own, recorded when they happen.
 * A fourth, `supervision-threw` (the watchdog's poll throwing, such as a progress log it can no
 * longer stat), is recorded by a handler attached at the spawn, so the rejection is never
 * unhandled however long the turn takes, and it is rethrown at the turn, where a sequential run
 * meets it.
 */

import type { ChildProcess } from 'node:child_process';

import type { TempDirOutcome } from '@vibe-agent-toolkit/utils';

import { errorMessageOf } from '../../utils/command-refusal.js';

import {
  closeOverlapSink,
  copyOverlapSink,
  openOverlapSink,
  type OverlapSinkFds,
  type ProgressLog,
  superviseRun,
  type SupervisedRun,
  type SupervisedVerb,
  withProgressLog,
} from './check-supervisor.js';

/** How often the turn reads what the child added to `stderr.log` while it still runs. */
const FOLLOW_INTERVAL_MS = 50;

/** How the overlapped run ended, recorded when it happened. */
type RecordedEnding = SupervisedRun | { readonly outcome: 'supervision-threw'; readonly error: unknown };

/** What the checks turn came to: the run's ending and leftover, and what the child had said before it. */
export type OverlappedTurn = TempDirOutcome<SupervisedRun> & {
  /** The bytes already in `stderr.log` when the turn started its copy: the child's buffered stderr. */
  readonly stderrBytesAtTurn: number;
};

/** A checks child spawned ahead of its turn, inside its open supervision scope. */
export interface OverlappedRun {
  /**
   * Resolves at the child's real `exit` (after the kill, when the supervision threw), or, for a
   * child that never started, when the run settles: the instant after which the parent's own
   * writes no longer overlap the child. A child whose SIGKILL the kernel refused never exits, and
   * this never resolves: a caller that must end waits on it together with the run's ending.
   */
  readonly exited: Promise<void>;
  /**
   * The checks turn: copy the child's stderr so far through `write`, follow it while the child
   * runs, make the final read once the run settles, then close the scope (guard released,
   * directory removed). The post-exit stdout grace starts no earlier than this call.
   *
   * @param write - Where the child's stderr goes, as raw bytes
   * @returns The recorded ending, with the directory as a `leftover` when the OS would not remove it,
   *   and the bytes the child had written before the turn
   * @throws The supervision's own error, after the scope is closed, when its poll threw
   */
  atTurn(write: (chunk: Buffer) => void): Promise<OverlappedTurn>;
  /**
   * End the run without a turn, for a run refusal in an earlier phase: kill the child's tree while
   * it runs, then close the scope. Its ending, a supervision throw included, is not published: the
   * refusal is the answer. A directory the OS would not remove is said on stderr. The kill is the
   * watchdog's own, so a refused kill is retried at its next breach, and the scope closes once the
   * child has exited or the watchdog has given up on it.
   *
   * A no-op once {@link atTurn} has been called: the turn owns the run's ending and its scope, so
   * an abandonment after it never closes the scope a second time, says no second leftover line,
   * and never replaces the run's own refusal with the turn's error.
   */
  abandon(): Promise<void>;
}

/**
 * Open the overlapped scope and spawn the checks child in it, unless the gate was disarmed while the
 * progress directory was being minted.
 *
 * `isArmed` is read after the mint (the scope's one asynchronous step) and immediately before the
 * synchronous spawn: false tears the scope down (guard released, directory removed) and spawns
 * nothing.
 *
 * @param options - The run: {@link superviseRun}'s, with `args` given the progress log's path
 * @param options.verb - The verb the child runs
 * @param options.args - The child's argv after the node binary, built from the minted log's path
 * @param options.budgetMs - How long silence is allowed to last
 * @param options.format - The format the child was asked for
 * @param options.isArmed - Whether the gate still wants the spawn
 * @returns The open run, or `'disarmed'` with the scope already closed
 */
export async function startOverlappedSupervision(options: {
  verb: SupervisedVerb;
  args: (logPath: string) => readonly string[];
  budgetMs: number;
  format: 'yaml' | 'json';
  isArmed: () => boolean;
}): Promise<OverlappedRun | 'disarmed'> {
  const opened = Promise.withResolvers<ProgressLog>();
  const close = Promise.withResolvers<undefined>();
  const scope = withProgressLog(options.verb, (log) => {
    opened.resolve(log);
    return close.promise;
  });
  // A mint that fails rejects the scope before any log exists.
  scope.then(() => undefined, opened.reject);
  const log = await opened.promise;
  const scopeCloser: ScopeCloser = {
    close: async () => {
      close.resolve(undefined);
      return (await scope).leftover;
    },
    fail: async (error) => {
      close.reject(error);
      // Rejects with `error` itself, once the directory is gone: the scope rethrows its work's
      // failure unchanged.
      await scope;
      // Type-level backstop: a scope whose work failed never resolves, so this line never runs.
      throw error;
    },
  };
  let sink: OverlapSinkFds | 'disarmed';
  try {
    sink = options.isArmed() ? openOverlapSink(log.path) : 'disarmed';
  } catch (error) {
    return scopeCloser.fail(error);
  }
  if (sink === 'disarmed') {
    sayLeftover(await scopeCloser.close());
    return 'disarmed';
  }
  // Any throw from here to the spawn rejects with the scope already closed, as the contract says.
  try {
    return spawnInScope(options, log, sink, scopeCloser);
  } catch (error) {
    return scopeCloser.fail(error);
  }
}

/** How the open scope ends: closed after its work, or failed with the error the caller then throws. */
interface ScopeCloser {
  /** Close it; resolves with the directory's leftover fault, if the OS would not remove it. */
  close(): Promise<unknown>;
  /** Fail it with `error`, and reject with `error` once the directory is gone. */
  fail(error: unknown): Promise<never>;
}

/**
 * Spawn the child into the open scope and hand back its handle.
 *
 * The write fd needs no guard: it is opened, given to the child and closed in one synchronous
 * stretch, which no signal handler or `exit` can interrupt. The read fd lives until the turn, so
 * the guard holds it and a takedown closes it before removing the directory.
 */
function spawnInScope(
  options: { verb: SupervisedVerb; args: (logPath: string) => readonly string[]; budgetMs: number; format: 'yaml' | 'json' },
  log: ProgressLog,
  sink: OverlapSinkFds,
  scope: ScopeCloser,
): OverlappedRun {
  let args: readonly string[];
  let closeRead: () => void;
  try {
    args = options.args(log.path);
    closeRead = log.guard.adoptFd(sink.readFd);
  } catch (error) {
    closeOverlapSink(sink);
    throw error;
  }
  const turn = Promise.withResolvers<undefined>();
  const abandoned = Promise.withResolvers<undefined>();
  const exited = Promise.withResolvers<undefined>();
  let child: ChildProcess | undefined;
  // Set by the turn: from then on the turn alone ends the run.
  let turnStarted = false;
  // The guard is told about the child exactly as a sequential run tells it; this scope listens too.
  const watched: ProgressLog = {
    path: log.path,
    guard: {
      watch: (spawned) => {
        log.guard.watch(spawned);
        child = spawned;
        spawned.once('exit', () => exited.resolve(undefined));
      },
      adoptFd: (fd) => log.guard.adoptFd(fd),
    },
  };
  // 🔑 The handler is attached here, at the spawn: a supervision that throws long before the turn is
  // recorded, never an unhandled rejection.
  const recorded: Promise<RecordedEnding> = superviseRun({
    verb: options.verb,
    args,
    log: watched,
    budgetMs: options.budgetMs,
    format: options.format,
    stderr: { sink: { fd: sink.writeFd, path: sink.path }, graceFrom: turn.promise, abandoned: abandoned.promise },
  }).then((run) => run, (error: unknown) => ({ outcome: 'supervision-threw', error }));
  // A child that never started (no child, or one with no pid) has no `exit`: the settled run stands
  // in for it. A child that did start resolves `exited` only at its own `exit`, even after a
  // supervision throw has settled the run. `recorded` never rejects.
  const runSettled = (): void => {
    if (child?.pid === undefined) exited.resolve(undefined);
  };
  recorded.then(runSettled, runSettled);

  return {
    exited: exited.promise,
    atTurn: async (write) => {
      turnStarted = true;
      turn.resolve(undefined);
      const replay = await replaySink(sink.readFd, write, Promise.race([exited.promise, recorded]), recorded);
      const ending = await recorded;
      closeRead();
      // The supervision's own throw is the run's ending; a replay that failed is secondary to it.
      if (ending.outcome === 'supervision-threw') return scope.fail(ending.error);
      if (replay.failure !== undefined) return scope.fail(replay.failure.error);
      return { value: ending, leftover: await scope.close(), stderrBytesAtTurn: replay.bytesAtTurn };
    },
    abandon: async () => {
      if (turnStarted) return;
      // The watchdog kills it, so a refused kill is retried as the watchdog's own are.
      abandoned.resolve(undefined);
      turn.resolve(undefined);
      await recorded;
      closeRead();
      sayLeftover(await scope.close());
    },
  };
}

/**
 * Copy `stderr.log` through `write` from offset 0, follow it until `childGone`, then make the final
 * read once `settled`.
 *
 * @param fd - The read fd
 * @param write - Where the bytes go
 * @param childGone - When following stops
 * @param settled - When the final read is made
 * @returns After the timer is stopped and `settled` reached: the bytes the first copy found (what
 *   the child wrote before the turn), and the read failure, if any
 */
async function replaySink(
  fd: number,
  write: (chunk: Buffer) => void,
  childGone: Promise<unknown>,
  settled: Promise<unknown>,
): Promise<{ bytesAtTurn: number; failure: { error: unknown } | undefined }> {
  let position = 0;
  let failure: { error: unknown } | undefined;
  const copyAvailable = (): void => {
    if (failure !== undefined) return;
    try {
      position = copyOverlapSink(fd, position, write);
    } catch (error) {
      failure = { error };
    }
  };
  copyAvailable();
  const bytesAtTurn = position;
  const timer = setInterval(copyAvailable, FOLLOW_INTERVAL_MS);
  try {
    await childGone;
  } finally {
    clearInterval(timer);
  }
  await settled;
  copyAvailable();
  return { bytesAtTurn, failure };
}

/**
 * Say, on stderr, a progress directory the OS would not remove, where no report will carry it: the
 * same line a guarded takedown writes.
 *
 * @param leftover - The disposal's fault, or `undefined` when the directory went
 */
function sayLeftover(leftover: unknown): void {
  if (leftover !== undefined) process.stderr.write(`${errorMessageOf(leftover)}\n`);
}
