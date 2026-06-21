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
