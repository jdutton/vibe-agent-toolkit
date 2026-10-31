/**
 * Creating, resetting and placing one arm's private directories. Each property
 * is read back from the filesystem rather than from the function's own return
 * value, so an implementation that names the right paths and creates none of
 * them cannot pass.
 *
 * Every destructive case aims at a scratch directory under the OS temp
 * directory and asserts the victim SURVIVED — never at a real tree.
 *
 * Integration-tier: real directories under the OS temp directory.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';

import { createSymlink, mkdirSyncReal, normalizedTmpdir, safePath, symlinkCapability } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ARM_REFUSED_CODE,
  armDirectories,
  armDirectoriesAt,
  armPlacementRefusal,
  prepareArmDirectories,
  resetArmHome,
  resetColdArm,
} from '../../src/harness/arm-dirs.js';

const POSIX = process.platform !== 'win32';

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

/** A directory the lab did not make, holding one file that must survive. */
function foreignTree(path: string): string {
  mkdirSyncReal(safePath.join(path, 'home'), { recursive: true, mode: 0o755 });
  const victim = safePath.join(path, 'home', 'keep.txt');
  writeFileSync(victim, 'not the lab’s');
  return victim;
}

const REFUSED = expect.objectContaining({ code: ARM_REFUSED_CODE }) as Error;

/**
 * Link `path` to the directory `target`, or skip the case visibly when this
 * host cannot make symlinks.
 */
function link(skip: () => never, target: string, path: string): void {
  createSymlink(symlinkCapability() ?? skip(), target, path, 'dir');
}

describe('prepareArmDirectories', () => {
  it('creates the arm and its tmp at 0700, marks the arm as the lab’s, and leaves the store for VAT', () => {
    const dirs = armDirectories({ out, build: 'cand', arm: 'C', state: 'warm' });
    prepareArmDirectories(dirs);
    expect(existsSync(dirs.tmp)).toBe(true);
    expect(existsSync(dirs.store)).toBe(false);
    expect(readdirSync(dirs.root)).toContain('.vat-lab-arm');
    if (POSIX) {
      expect(mode(dirs.root)).toBe(0o700);
      expect(mode(dirs.tmp)).toBe(0o700);
    }
  });

  it('accepts an arm it made before', () => {
    const dirs = armDirectories({ out, build: 'cand', arm: 'C', state: 'warm' });
    prepareArmDirectories(dirs);
    expect(() => prepareArmDirectories(dirs)).not.toThrow();
  });

  it('refuses — and neither chmods nor touches — an existing directory the lab never marked', () => {
    const root = safePath.join(out, 'app');
    const victim = foreignTree(root);
    const dirs = armDirectoriesAt(root);

    expect(() => prepareArmDirectories(dirs)).toThrow(REFUSED);
    expect(readFileSync(victim, 'utf-8')).toBe('not the lab’s');
    if (POSIX) expect(mode(safePath.join(root, 'home'))).toBe(0o755);
    expect(readdirSync(root)).not.toContain('.vat-lab-arm');
  });

  it.skipIf(!POSIX)('refuses a symlinked <out>/arms, and creates nothing through it', ({ skip }) => {
    const elsewhere = mkdtempSync(safePath.join(out, 'elsewhere-'));
    link(skip, elsewhere, safePath.join(out, 'arms'));

    expect(() => prepareArmDirectories(armDirectories({ out, build: 'cand', arm: 'C', state: 'cold' }))).toThrow(REFUSED);
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it.skipIf(!POSIX)('refuses a symlinked arm directory', ({ skip }) => {
    const dirs = armDirectories({ out, build: 'cand', arm: 'C', state: 'cold' });
    const elsewhere = mkdtempSync(safePath.join(out, 'elsewhere-'));
    mkdirSyncReal(safePath.join(out, 'arms'));
    link(skip, elsewhere, dirs.root);

    expect(() => prepareArmDirectories(dirs)).toThrow(REFUSED);
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it.skipIf(!POSIX)('refuses a symlinked tmp inside a marked arm, rather than chmodding its target', ({ skip }) => {
    const dirs = armDirectories({ out, build: 'cand', arm: 'C', state: 'cold' });
    prepareArmDirectories(dirs);
    const elsewhere = mkdtempSync(safePath.join(out, 'elsewhere-'));
    rmSync(dirs.tmp, { recursive: true });
    link(skip, elsewhere, dirs.tmp);
    const before = mode(elsewhere);

    expect(() => prepareArmDirectories(dirs)).toThrow(REFUSED);
    expect(mode(elsewhere)).toBe(before);
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
    if (POSIX) expect(mode(dirs.home)).toBe(0o700);
  });

  it('never deletes the home of a directory the lab did not mark', async () => {
    const root = safePath.join(out, 'app');
    const victim = foreignTree(root);

    await expect(resetArmHome(armDirectoriesAt(root))).rejects.toThrow(REFUSED);
    expect(readFileSync(victim, 'utf-8')).toBe('not the lab’s');
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

  it('never deletes the store of a directory the lab did not mark', async () => {
    const root = safePath.join(out, 'app');
    foreignTree(root);
    const victim = safePath.join(root, 'store', 'data.db');
    mkdirSyncReal(safePath.join(root, 'store'));
    writeFileSync(victim, 'not the lab’s');

    await expect(resetColdArm(armDirectoriesAt(root))).rejects.toThrow(REFUSED);
    expect(readFileSync(victim, 'utf-8')).toBe('not the lab’s');
  });
});

describe('armPlacementRefusal', () => {
  it('refuses an arm directory equal to, inside, or containing a subject, and accepts a sibling', () => {
    const subject = safePath.join(out, 'workspace', 'app');
    mkdirSyncReal(subject, { recursive: true });

    expect(armPlacementRefusal(subject, [subject])).toMatch(/subject/u);
    expect(armPlacementRefusal(safePath.join(subject, 'arms', 'x'), [subject])).toMatch(/inside/u);
    expect(armPlacementRefusal(safePath.join(out, 'workspace'), [subject])).toMatch(/contains/u);
    expect(armPlacementRefusal(safePath.join(out, 'lab-out', 'arms', 'x'), [subject])).toBeNull();
  });
});
