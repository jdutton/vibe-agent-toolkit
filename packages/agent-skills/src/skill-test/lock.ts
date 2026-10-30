import { closeSync, openSync, rmSync } from 'node:fs';

import { ExitCode } from '@vibe-agent-toolkit/schema';
import { isAlreadyExistsError, safePath, VatError, withFsFaultSync } from '@vibe-agent-toolkit/utils';
import { handleTerminatingSignals, type TerminatingSignalGuard } from '@vibe-agent-toolkit/utils/process';

/**
 * The harness root for a subject set is already locked.
 *
 * Reason `preflight`, not `internal`. This is the most user-correctable condition in
 * the command — the remedy is "wait, or delete one file" — and it was the ONE error
 * class in this feature with no declared reason, so it fell through
 * `skillTestFailureReason`'s default to `internal`. The published CI recipe reads
 * `internal` as "the harness broke, fail the build", which is exactly the wrong
 * verdict for a lock held by the operator's own second terminal.
 *
 * The field below is what `skillTestFailureReason` READS — it is not decoration
 * mirroring an `instanceof` row, which is what it was when it was added. Deleting it
 * turns this back into `internal`.
 *
 * The message names `lockPath` because the lockfile is created `O_EXCL` in the
 * DETERMINISTIC harness root and released only on normal exit or a terminating signal —
 * a SIGKILL, an OOM, or a crash leaves it behind and every later run of that skill
 * fails here, with no `--force` to escape. Until the staleness protocol (pid +
 * timestamp + liveness probe + `--force`) lands in its own lane, naming the path
 * and saying to delete it IS the escape hatch, so it belongs in the message rather
 * than in a doc the operator is not currently reading.
 */
export class HarnessLockBusyError extends VatError {
  readonly reason = 'preflight' as const;
  constructor(public readonly lockPath: string) {
    super(
      'HARNESS_LOCK_BUSY',
      `Another vat skill test run holds the harness lock: ${lockPath}. ` +
        'Wait for it to finish, or use a different subject set. ' +
        'If no other run is in progress the lock is stale (a previous run was killed, ' +
        `crashed, or ran out of memory) — delete ${lockPath} and re-run.`,
    );
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
 * contract in the definition — `release()` never throws — means there is no unwrapped
 * call site left to lose. Note what that does NOT mean: `release(): void` encodes
 * nothing about throwing, because TypeScript has no throws clause. The contract is
 * held up by the two nested `try`s below and by the tests that pin each one, not by
 * the signature.
 *
 * BOTH statements of the catch are guarded, and the second one is why: the warning
 * write is itself an fd-level operation, and a synchronous EBADF/EPIPE on a file- or
 * TTY-backed fd 2 threw straight back out — reinstating the exact failure the outer
 * catch was added to prevent, on a path only reachable once something had already
 * gone wrong. A test that mocks `process.stderr.write` to RETURN cannot see it.
 *
 * The failure is not silent: a lockfile that could not be removed will fail the NEXT
 * run of this skill with a "busy" error, and an operator who saw nothing here has no
 * way to connect the two.
 */
export function acquireHarnessLock(harnessRoot: string, opts: { wait?: boolean } = {}): HarnessLock {
  const lockPath = safePath.joinUnderRoot(harnessRoot, '.vat-skill-test.lock');
  // eslint-disable-next-line no-void, sonarjs/void-use -- v1: fail-fast only; reserved for future polling
  void opts.wait;
  // Any refusal but "already exists" (a full disk, a read-only root) is the run's output, not a held lock.
  const fd = withFsFaultSync({ side: 'destination', action: `create the harness lockfile ${lockPath}` }, () => {
    try {
      // 'wx' = O_CREAT | O_EXCL — fails with EEXIST if the lockfile already exists.
      return openSync(lockPath, 'wx');
    } catch (err) {
      if (isAlreadyExistsError(err)) throw new HarnessLockBusyError(lockPath);
      throw err;
    }
  });
  closeSync(fd);
  let released = false;
  return {
    release(): void {
      if (released) return;
      released = true;
      try {
        rmSync(lockPath, { force: true });
      } catch (err) {
        try {
          process.stderr.write(
            `warning: could not remove the harness lockfile ${lockPath} (the run's result stands): ` +
              `${err instanceof Error ? err.message : String(err)}. ` +
              'The next run of this skill will report the lock as busy until it is deleted.\n',
          );
          // eslint-disable-next-line local/no-blind-catch -- the REPORTING channel (fd 2) is what threw; there is no surface left to carry the error to, and a rethrow from a `finally` would destroy a good harness result
        } catch {
          // The REPORTING channel is what failed — an EBADF/EPIPE on a file- or
          // TTY-backed fd 2 throws synchronously out of `write`. There is nowhere
          // left to report it to, and rethrowing here would do exactly what the
          // outer catch exists to prevent: destroy a good result from the harness
          // `finally`. Swallowed deliberately, and it is the only swallow in this
          // module that has no alternative surface.
        }
      }
    },
  };
}

/**
 * Guard every terminating signal while the harness lock is held: on the first, run `onSignal`
 * (release the lock, remove the harness dir — so a Ctrl-C mid-run leaves neither
 * `.vat-skill-test.lock` nor staged untrusted bytes behind), then die of the signal (128+n on
 * POSIX; exit 2 on Windows).
 *
 * Through `handleTerminatingSignals`, so a REPEAT — a terminal Ctrl-C under the `vat` wrapper
 * arrives twice — is swallowed until `onSignal` has settled, whichever way it settles: `onSignal`
 * reports its own failures.
 *
 * @param onSignal - The cleanup
 * @returns The guard — the caller MUST release it on normal completion so listeners do not
 *   accumulate across runs in a long-lived process (and so tests stay isolated), and only once its
 *   own run of the same cleanup has SETTLED: a signal during that run must still be guarded
 */
export function installSignalCleanup(onSignal: () => Promise<void>): TerminatingSignalGuard {
  return handleTerminatingSignals({ cleanup: onSignal, fallbackExitCode: ExitCode.ERROR });
}
