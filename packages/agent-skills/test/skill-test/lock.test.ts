import { mkdtempSync, rmSync } from 'node:fs';

import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { withSyncFsRefused } from '@vibe-agent-toolkit/utils/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { acquireHarnessLock, HarnessLockBusyError, installSignalCleanup } from '../../src/skill-test/lock.js';

/**
 * Make the lockfile unremovable, so `rmSync` inside `release()` is guaranteed to
 * throw. A NON-EMPTY DIRECTORY at the lock path does it on every platform: `rmSync`
 * without `recursive` throws `ERR_FS_EISDIR` from Node itself, so no `node:fs` mock
 * and no dependence on POSIX permission bits.
 */
function makeLockfileUnremovable(root: string): void {
  const lockPath = safePath.join(root, '.vat-skill-test.lock');
  rmSync(lockPath);
  mkdirSyncReal(safePath.join(lockPath, 'occupied'), { recursive: true });
}

describe('acquireHarnessLock', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-lock-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('acquires then releases', () => {
    const lock = acquireHarnessLock(root);
    expect(() => lock.release()).not.toThrow();
  });

  // A lockfile the OS will not let the run create (a full disk, a read-only root) is
  // the run not finishing — RUN_INCOMPLETE — never an uncoded errno (INTERNAL_ERROR).
  it('codes a lockfile the OS refuses to create as the run\'s output (a destination fault)', async () => {
    await withSyncFsRefused('openSync', safePath.join(root, '.vat-skill-test.lock'), 'ENOSPC', () => {
      expect(() => acquireHarnessLock(root)).toThrow(expect.objectContaining({ code: 'FS_FAULT', side: 'destination', faultClass: 'exhausted' }));
    });
  });

  it('a second acquire fails fast while held', () => {
    const lock = acquireHarnessLock(root);
    expect(() => acquireHarnessLock(root, { wait: false })).toThrow(HarnessLockBusyError);
    lock.release();
  });

  /**
   * `release()` runs from the harness `finally`, so a throw there REPLACES an
   * already-good result — verdict computed, artifacts written — with exit 1 and no
   * summary. `rmSync(..., {force: true})` swallows only ENOENT, so an
   * EPERM/EACCES/EROFS on the lockfile escaped.
   *
   * The unremovable lockfile is faked as a NON-EMPTY DIRECTORY at the lock path:
   * `rmSync` on a directory without `recursive` throws `ERR_FS_EISDIR` from Node
   * itself, so this reproduces "the unlink failed" on every platform without
   * mocking `node:fs` or depending on POSIX permission bits.
   */
  it('never throws out of release(), even when the lockfile cannot be removed', () => {
    const lock = acquireHarnessLock(root);
    makeLockfileUnremovable(root);

    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      expect(() => lock.release()).not.toThrow();
      // Swallowed, NOT silent: the next run of this skill will report the lock as
      // busy, and an operator who saw nothing here cannot connect the two.
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('.vat-skill-test.lock'));
    } finally {
      stderr.mockRestore();
    }
  });

  /**
   * The SECOND statement of that `catch` is the warning write, and it was unguarded.
   * A synchronous fd-level failure on stderr (EBADF on a file- or TTY-backed fd 2)
   * throws straight back out of `release()` — from the harness `finally`, replacing an
   * already-good result with exit 1 and no summary. The test above cannot observe
   * this by construction: its spy returns `true`.
   *
   * `release(): void` encodes nothing about throwing — TypeScript has no throws
   * clause — so this is the only thing holding the "NEVER THROWS" contract up.
   */
  it('never throws out of release() when the WARNING WRITE itself fails (EBADF on fd 2)', () => {
    const lock = acquireHarnessLock(root);
    makeLockfileUnremovable(root);

    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => {
      throw Object.assign(new Error('EBADF: bad file descriptor, write'), { code: 'EBADF' });
    });
    try {
      expect(() => lock.release()).not.toThrow();
      expect(stderr).toHaveBeenCalledTimes(1); // it DID try to warn — the throw is real, not skipped
    } finally {
      stderr.mockRestore();
    }
  });

  it('can re-acquire after release', () => {
    acquireHarnessLock(root).release();
    expect(() => {
      const lock2 = acquireHarnessLock(root, { wait: false });
      lock2.release();
    }).not.toThrow();
  });
});

describe('installSignalCleanup', () => {
  const settled = (): Promise<void> => Promise.resolve();

  it('registers SIGINT and SIGTERM handlers and removes them on dispose', () => {
    const beforeInt = process.listenerCount('SIGINT');
    const beforeTerm = process.listenerCount('SIGTERM');

    const remove = installSignalCleanup({ onSignal: settled, exit: () => {} });
    expect(process.listenerCount('SIGINT')).toBe(beforeInt + 1);
    expect(process.listenerCount('SIGTERM')).toBe(beforeTerm + 1);

    remove();
    expect(process.listenerCount('SIGINT')).toBe(beforeInt);
    expect(process.listenerCount('SIGTERM')).toBe(beforeTerm);
  });

  it('runs onSignal and exits 130 on SIGINT only once it has settled, self-removing the handler', async () => {
    let finishCleanup: () => void = () => {};
    const exitCodes: number[] = [];
    installSignalCleanup({
      onSignal: () => new Promise<void>((resolve) => { finishCleanup = resolve; }),
      exit: (c) => { exitCodes.push(c); },
    });

    const before = process.listenerCount('SIGINT');
    process.emit('SIGINT');

    // The handler removed itself, so no listener leaks even on the signal path.
    expect(process.listenerCount('SIGINT')).toBe(before - 1);
    // Cleanup still running: an exit now would leave half of what it removes.
    await settled();
    expect(exitCodes).toEqual([]);
    finishCleanup();
    await vi.waitFor(() => { expect(exitCodes).toEqual([130]); }); // 128 + SIGINT(2)
  });

  it('exits 143 on SIGTERM, even when cleanup rejects', async () => {
    const exitCodes: number[] = [];
    const remove = installSignalCleanup({ onSignal: () => Promise.reject(new Error('cleanup failed')), exit: (c) => { exitCodes.push(c); } });

    process.emit('SIGTERM');
    await vi.waitFor(() => { expect(exitCodes).toEqual([143]); }); // 128 + SIGTERM(15)

    remove(); // idempotent after the handler already self-removed
  });
});
