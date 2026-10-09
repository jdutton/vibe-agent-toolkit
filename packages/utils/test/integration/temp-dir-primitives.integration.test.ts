/**
 * The per-call temp-directory primitives: minted under the real tmpdir,
 * removed by a teardown that refuses anything NOT under it. The refusal is
 * the point — a teardown is the one `rm -rf` on a variable that test code
 * runs, and an unassigned or misassigned variable must not become
 * `rm -rf ''` or `rm -rf packages/`.
 */
import { existsSync, writeFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isUnderRoot } from '../../src/path-containment.js';
import { mkdirSyncReal, normalizedTmpdir, safePath } from '../../src/path-utils.js';
import { createTempDir, createTempDirAsync, registerScratchTmpdir, removeTempDir, scratchTmpdirEnv, tempDirTracker } from '../../src/testing/temp-dir.js';

describe('temp-dir primitives', () => {
  it('createTempDir mints a fresh directory strictly under the host tmpdir', () => {
    const dir = createTempDir('t7-primitives-');
    try {
      expect(isUnderRoot(normalizedTmpdir(), dir)).toBe('inside');
      expect(dir).toContain('t7-primitives-');
    } finally {
      removeTempDir(dir);
    }
    expect(existsSync(dir)).toBe(false);
  });

  it('createTempDirAsync does the same, asynchronously', async () => {
    const dir = await createTempDirAsync('t7-primitives-async-');
    expect(isUnderRoot(normalizedTmpdir(), dir)).toBe('inside');
    removeTempDir(dir);
    expect(existsSync(dir)).toBe(false);
  });

  it('removeTempDir tolerates a directory already gone, and removes a populated one', () => {
    const dir = createTempDir('t7-primitives-populated-');
    mkdirSyncReal(safePath.join(dir, 'nested', 'deep'), { recursive: true });
    writeFileSync(safePath.join(dir, 'nested', 'deep', 'f.txt'), 'x');
    removeTempDir(dir);
    removeTempDir(dir);
    expect(existsSync(dir)).toBe(false);
  });

  it('removeTempDir refuses, by name, anything outside the host tmpdir — the empty string included', () => {
    expect(() => removeTempDir('')).toThrow(/not inside the host tmpdir/);
    expect(() => removeTempDir(process.cwd())).toThrow(/not inside the host tmpdir/);
    expect(() => removeTempDir(normalizedTmpdir())).toThrow(/not inside the host tmpdir/);
    expect(existsSync(process.cwd())).toBe(true);
  });

  it('tempDirTracker removes every directory it minted and nothing else', () => {
    const tracker = tempDirTracker('t7-tracker-');
    const a = tracker.create();
    const b = tracker.create();
    const bystander = createTempDir('t7-bystander-');
    try {
      expect(a).not.toBe(b);
      tracker.cleanupAll();
      expect(existsSync(a)).toBe(false);
      expect(existsSync(b)).toBe(false);
      expect(existsSync(bystander)).toBe(true);
      tracker.cleanupAll();
    } finally {
      removeTempDir(bystander);
    }
  });
});

describe('scratchTmpdirEnv', () => {
  it('makes a fresh scratch THE temp directory, then restores the environment and removes it', () => {
    const before = ['TMPDIR', 'TEMP', 'TMP'].map((name) => process.env[name]);
    const realTmp = normalizedTmpdir();
    const scratch = scratchTmpdirEnv('t20-scratch-');

    const dir = scratch.enter();
    try {
      expect(isUnderRoot(realTmp, dir)).toBe('inside');
      expect(safePath.resolve(normalizedTmpdir())).toBe(safePath.resolve(dir));
      expect(scratch.current()).toBe(dir);
    } finally {
      scratch.leave();
    }

    expect(['TMPDIR', 'TEMP', 'TMP'].map((name) => process.env[name])).toEqual(before);
    expect(normalizedTmpdir()).toBe(realTmp);
    expect(existsSync(dir)).toBe(false);
    expect(() => scratch.current()).toThrow(/no scratch/);
  });
});

describe('registerScratchTmpdir', () => {
  const realTmp = normalizedTmpdir();
  const current = registerScratchTmpdir('t20-registered-', { beforeEach, afterEach });

  it('points the temp directory at a scratch for each test', () => {
    expect(safePath.resolve(normalizedTmpdir())).toBe(safePath.resolve(current()));
    expect(isUnderRoot(realTmp, current())).toBe('inside');
  });
});
