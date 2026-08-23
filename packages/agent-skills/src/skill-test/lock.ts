import { closeSync, openSync, rmSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';

/**
 * The harness root for a subject set is already locked.
 *
 * Exit 2 (PREFLIGHT), not 1. This is the most user-correctable condition in the
 * command — the remedy is "wait, or delete one file" — and it was the ONE error
 * class in this feature with no `exitCode`, so it fell through
 * `mapErrorToExitCode`'s default to Internal (1). The published CI recipe reads 1
 * as "the harness broke, fail the build", which is exactly the wrong verdict for a
 * lock held by the operator's own second terminal.
 *
 * The field below is what `mapErrorToExitCode` READS — it is not decoration
 * mirroring an `instanceof` row, which is what it was when it was added. Deleting it
 * turns this back into an exit 1.
 *
 * The message names `lockPath` because the lockfile is created `O_EXCL` in the
 * DETERMINISTIC harness root and released only on normal exit or SIGINT/SIGTERM —
 * a SIGKILL, an OOM, or a crash leaves it behind and every later run of that skill
 * fails here, with no `--force` to escape. Until the staleness protocol (pid +
 * timestamp + liveness probe + `--force`) lands in its own lane, naming the path
 * and saying to delete it IS the escape hatch, so it belongs in the message rather
 * than in a doc the operator is not currently reading.
 */
export class HarnessLockBusyError extends Error {
  readonly exitCode = 2 as const;
  constructor(public readonly lockPath: string) {
    super(
      `Another vat skill test run holds the harness lock: ${lockPath}. ` +
        'Wait for it to finish, or use a different subject set. ' +
        'If no other run is in progress the lock is stale (a previous run was killed, ' +
        `crashed, or ran out of memory) — delete ${lockPath} and re-run.`,
    );
    this.name = 'HarnessLockBusyError';
  }
}

export interface HarnessLock {
  /**
   * Release the lock. NEVER THROWS — see {@link acquireHarnessLock}. Callers run
   * this from a cleanup path and must be able to call it bare.
   */
  release(): void;
}

/**
 * Exclusive harness lock via atomic O_EXCL lockfile creation (spec §7). Guards
 * vat-vs-vat staging/result races for the same subject set. `wait: false`
 * fails fast; the default `wait: true` is reserved for the CLI to poll (v1
 * keeps the simple fail-fast — the CLI surfaces the busy message).
 *
 * ACQUIRING can throw (that is the whole point: EEXIST → {@link HarnessLockBusyError}).
 * RELEASING cannot, and that asymmetry is deliberate. `rmSync(..., {force: true})`
 * swallows only ENOENT, so an EPERM/EACCES/EROFS on the lockfile — a read-only
 * volume, a `root`-owned temp dir, a Windows handle still open — threw out of the
 * harness `finally` and REPLACED an already-good result (verdict computed, artifacts
 * written, summary composed) with exit 1 and no summary, every artifact sitting
 * unread on disk.
 *
 * The guard lives HERE rather than at the call site, where it originally went. A
 * call-site wrapper is invisible to the compiler: reverting it to a bare
 * `lock.release()` left the whole unit suite AND the integration suite green, so
 * nothing but review stood between the fix and its own silent removal. Owning the
 * contract in the type — `release()` never throws — means there is no unwrapped call
 * site left to lose.
 *
 * The failure is not silent: a lockfile that could not be removed will fail the NEXT
 * run of this skill with a "busy" error, and an operator who saw nothing here has no
 * way to connect the two.
 */
export function acquireHarnessLock(harnessRoot: string, opts: { wait?: boolean } = {}): HarnessLock {
  const lockPath = safePath.joinUnderRoot(harnessRoot, '.vat-skill-test.lock');
  // eslint-disable-next-line no-void, sonarjs/void-use -- v1: fail-fast only; reserved for future polling
  void opts.wait;
  let fd: number;
  try {
    // 'wx' = O_CREAT | O_EXCL — fails with EEXIST if the lockfile already exists.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- our own derived harness root
    fd = openSync(lockPath, 'wx');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new HarnessLockBusyError(lockPath);
    }
    throw err;
  }
  closeSync(fd);
  let released = false;
  return {
    release(): void {
      if (released) return;
      released = true;
      try {
        rmSync(lockPath, { force: true });
      } catch (err) {
        process.stderr.write(
          `warning: could not remove the harness lockfile ${lockPath} (the run's result stands): ` +
            `${err instanceof Error ? err.message : String(err)}. ` +
            'The next run of this skill will report the lock as busy until it is deleted.\n',
        );
      }
    },
  };
}

/** Conventional shell exit-code base for a process terminated by a signal. */
const SIGNAL_EXIT_BASE = 128;

/** Signals we trap so an interrupted run cleans up instead of leaking the lock. */
const SIGNAL_NUMBERS: ReadonlyArray<readonly [NodeJS.Signals, number]> = [
  ['SIGINT', 2],
  ['SIGTERM', 15],
];

export interface InstallSignalCleanupOptions {
  /**
   * Invoked once on the first trapped signal, BEFORE exiting — the place to
   * release the harness lock and remove the harness dir so a Ctrl-C mid-run does
   * not leave `.vat-skill-test.lock` (or staged untrusted bytes) behind.
   */
  onSignal: () => void;
  /**
   * Exit hook, injectable for tests. Defaults to `process.exit`. Called with the
   * conventional 128+signal code so the signal is honored, not swallowed.
   */
  exit?: (code: number) => void;
}

/**
 * Trap SIGINT/SIGTERM while the harness lock is held. On the first such signal
 * the handler removes ITSELF (no listener leak, no re-entry), runs `onSignal`
 * (release lock + clean up), then exits with the conventional 128+signal code.
 *
 * Returns a disposer that removes the handlers — the caller MUST call it on
 * normal completion so listeners do not accumulate across runs in a long-lived
 * process (and so tests stay isolated).
 */
export function installSignalCleanup(opts: InstallSignalCleanupOptions): () => void {
  const exit = opts.exit ?? ((code: number): void => { process.exit(code); });
  const registered: Array<readonly [NodeJS.Signals, () => void]> = [];
  const remove = (): void => {
    for (const [sig, handler] of registered) process.off(sig, handler);
  };
  for (const [sig, num] of SIGNAL_NUMBERS) {
    const handler = (): void => {
      remove();
      opts.onSignal();
      exit(SIGNAL_EXIT_BASE + num);
    };
    process.on(sig, handler);
    registered.push([sig, handler]);
  }
  return remove;
}
