import { mkdtempSync, rmSync } from 'node:fs';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { acquireHarnessLock, HarnessLockBusyError } from '../../src/skill-test/lock.js';

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
