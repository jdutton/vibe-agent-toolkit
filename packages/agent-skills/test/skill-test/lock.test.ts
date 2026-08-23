import { mkdtempSync, rmSync } from 'node:fs';

import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { acquireHarnessLock, HarnessLockBusyError, installSignalCleanup } from '../../src/skill-test/lock.js';

describe('acquireHarnessLock', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-lock-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('acquires then releases', () => {
    const lock = acquireHarnessLock(root);
    expect(() => lock.release()).not.toThrow();
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
    const lockPath = safePath.join(root, '.vat-skill-test.lock');
    rmSync(lockPath);
    mkdirSyncReal(safePath.join(lockPath, 'occupied'), { recursive: true });

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

  it('can re-acquire after release', () => {
    acquireHarnessLock(root).release();
    expect(() => {
      const lock2 = acquireHarnessLock(root, { wait: false });
      lock2.release();
    }).not.toThrow();
  });
});

describe('installSignalCleanup', () => {
  it('registers SIGINT and SIGTERM handlers and removes them on dispose', () => {
    const beforeInt = process.listenerCount('SIGINT');
    const beforeTerm = process.listenerCount('SIGTERM');

    const remove = installSignalCleanup({ onSignal: () => {}, exit: () => {} });
    expect(process.listenerCount('SIGINT')).toBe(beforeInt + 1);
    expect(process.listenerCount('SIGTERM')).toBe(beforeTerm + 1);

    remove();
    expect(process.listenerCount('SIGINT')).toBe(beforeInt);
    expect(process.listenerCount('SIGTERM')).toBe(beforeTerm);
  });

  it('runs onSignal and exits 130 on SIGINT, self-removing the handler', () => {
    let cleaned = false;
    const exitCodes: number[] = [];
    installSignalCleanup({ onSignal: () => { cleaned = true; }, exit: (c) => { exitCodes.push(c); } });

    const before = process.listenerCount('SIGINT');
    process.emit('SIGINT');

    expect(cleaned).toBe(true);
    expect(exitCodes).toEqual([130]); // 128 + SIGINT(2)
    // The handler removed itself, so no listener leaks even on the signal path.
    expect(process.listenerCount('SIGINT')).toBe(before - 1);
  });

  it('exits 143 on SIGTERM', () => {
    const exitCodes: number[] = [];
    const remove = installSignalCleanup({ onSignal: () => {}, exit: (c) => { exitCodes.push(c); } });

    process.emit('SIGTERM');
    expect(exitCodes).toEqual([143]); // 128 + SIGTERM(15)

    remove(); // idempotent after the handler already self-removed
  });
});
