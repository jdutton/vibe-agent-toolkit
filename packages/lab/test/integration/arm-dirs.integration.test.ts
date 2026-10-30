/**
 * Creating and resetting one arm's private directories. Each property is read
 * back from the filesystem rather than from the function's own return value, so
 * an implementation that names the right paths and creates none of them cannot
 * pass.
 *
 * Integration-tier: real directories under the OS temp directory.
 */

import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { armDirectories, prepareArmDirectories, resetArmHome, resetColdArm } from '../../src/harness/arm-dirs.js';

let out: string;

beforeEach(() => {
  out = mkdtempSync(safePath.join(normalizedTmpdir(), 'lab-arm-dirs-'));
});

afterEach(() => {
  rmSync(out, { recursive: true, force: true });
});

/** The permission bits of a path. */
function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

describe('prepareArmDirectories', () => {
  it('creates the arm and its tmp at 0700, and leaves the store for VAT to create', () => {
    const dirs = armDirectories({ out, build: 'cand', arm: 'C', state: 'warm' });
    prepareArmDirectories(dirs);
    expect(existsSync(dirs.tmp)).toBe(true);
    expect(existsSync(dirs.store)).toBe(false);
    if (process.platform !== 'win32') {
      expect(mode(dirs.root)).toBe(0o700);
      expect(mode(dirs.tmp)).toBe(0o700);
    }
  });
});

describe('resetArmHome', () => {
  it('deletes and re-creates the home empty, rather than asserting it empty', async () => {
    const dirs = armDirectories({ out, build: 'cand', arm: 'C', state: 'warm' });
    prepareArmDirectories(dirs);
    mkdirSyncReal(safePath.join(dirs.home, '.claude'), { recursive: true });
    writeFileSync(safePath.join(dirs.home, '.claude', 'CLAUDE.md'), 'left by a previous sequence');
    await resetArmHome(dirs);
    expect(readdirSync(dirs.home)).toStrictEqual([]);
    if (process.platform !== 'win32') expect(mode(dirs.home)).toBe(0o700);
  });
});

describe('resetColdArm', () => {
  it('deletes the store and empties tmp, and reports no violation', async () => {
    const dirs = armDirectories({ out, build: 'cand', arm: 'C', state: 'cold' });
    prepareArmDirectories(dirs);
    mkdirSyncReal(dirs.store);
    writeFileSync(safePath.join(dirs.store, 'projection.db'), 'warm');
    mkdirSyncReal(safePath.join(dirs.tmp, '.vat-cache', 'ns', 'parse'), { recursive: true });
    writeFileSync(safePath.join(dirs.tmp, '.vat-cache', 'ns', 'parse', 'shard.json'), '{}');

    expect(await resetColdArm(dirs)).toBeNull();
    expect(existsSync(dirs.store)).toBe(false);
    expect(readdirSync(dirs.tmp)).toStrictEqual([]);
  });

  it('is a no-op on an arm whose store was never made', async () => {
    const dirs = armDirectories({ out, build: 'cand', arm: 'C', state: 'cold' });
    prepareArmDirectories(dirs);

    expect(await resetColdArm(dirs)).toBeNull();
    expect(readdirSync(dirs.tmp)).toStrictEqual([]);
  });
});
