import { mkdtempSync, rmSync } from 'node:fs';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
