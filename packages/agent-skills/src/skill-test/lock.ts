import { closeSync, openSync, rmSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';

export class HarnessLockBusyError extends Error {
  constructor(lockPath: string) {
    super(`Another vat skill test run holds the harness lock: ${lockPath}. Wait for it to finish or use a different subject set.`);
    this.name = 'HarnessLockBusyError';
  }
}

export interface HarnessLock {
  release(): void;
}

/**
 * Exclusive harness lock via atomic O_EXCL lockfile creation (spec §7). Guards
 * vat-vs-vat staging/result races for the same subject set. `wait: false`
 * fails fast; the default `wait: true` is reserved for the CLI to poll (v1
 * keeps the simple fail-fast — the CLI surfaces the busy message).
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
      rmSync(lockPath, { force: true });
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
