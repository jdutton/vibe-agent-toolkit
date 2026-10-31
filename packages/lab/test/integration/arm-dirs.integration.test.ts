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

import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';

import { createSymlink, mkdirSyncReal, normalizedTmpdir, normalizePath, safePath, symlinkCapability } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ARM_REFUSED_CODE,
  armDirectories,
  armDirectoriesAt,
  armPlacementRefusal,
  openArmsRoot,
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
  vi.unstubAllEnvs();
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
    const dirs = armDirectories({ root: safePath.join(out, 'arms'), build: 'cand', arm: 'C', state: 'warm' });
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
    const dirs = armDirectories({ root: safePath.join(out, 'arms'), build: 'cand', arm: 'C', state: 'warm' });
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

    expect(() => prepareArmDirectories(armDirectories({ root: safePath.join(out, 'arms'), build: 'cand', arm: 'C', state: 'cold' }))).toThrow(REFUSED);
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it.skipIf(!POSIX)('refuses a symlinked arm directory', ({ skip }) => {
    const dirs = armDirectories({ root: safePath.join(out, 'arms'), build: 'cand', arm: 'C', state: 'cold' });
    const elsewhere = mkdtempSync(safePath.join(out, 'elsewhere-'));
    mkdirSyncReal(safePath.join(out, 'arms'));
    link(skip, elsewhere, dirs.root);

    expect(() => prepareArmDirectories(dirs)).toThrow(REFUSED);
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it.skipIf(!POSIX)('refuses a symlinked tmp inside a marked arm, rather than chmodding its target', ({ skip }) => {
    const dirs = armDirectories({ root: safePath.join(out, 'arms'), build: 'cand', arm: 'C', state: 'cold' });
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
    const dirs = armDirectories({ root: safePath.join(out, 'arms'), build: 'cand', arm: 'C', state: 'warm' });
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
    const dirs = armDirectories({ root: safePath.join(out, 'arms'), build: 'cand', arm: 'C', state: 'cold' });
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
    const dirs = armDirectories({ root: safePath.join(out, 'arms'), build: 'cand', arm: 'C', state: 'cold' });
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

/** Point the OS temp directory at this case's scratch directory. */
function scratchTmpdir(): string {
  for (const name of ['TMPDIR', 'TEMP', 'TMP']) vi.stubEnv(name, out);
  return normalizePath(out, out);
}

describe('openArmsRoot', () => {

  it('defaults to a fresh owner-only run directory under <os tmpdir>/vat-lab-arms-<user>, outside every subject', () => {
    const tmp = scratchTmpdir();
    const subject = mkdtempSync(safePath.join(out, 'subject-'));

    const first = openArmsRoot({ override: null, subjects: [subject] });
    const second = openArmsRoot({ override: null, subjects: [subject] });

    expect(first).not.toBe(second);
    const base = dirname(first);
    expect(dirname(second)).toBe(base);
    expect(basename(base)).toMatch(/^vat-lab-arms-[\w.-]+$/u);
    expect(normalizePath(dirname(base), out)).toBe(tmp);
    expect(readdirSync(first)).toStrictEqual([]);
    if (POSIX) {
      expect(mode(base)).toBe(0o700);
      expect(mode(first)).toBe(0o700);
    }
  });

  it.skipIf(!POSIX)('refuses a default base that is a symlink, creating nothing through it', ({ skip }) => {
    scratchTmpdir();
    const base = dirname(openArmsRoot({ override: null, subjects: [] }));
    rmSync(base, { recursive: true });
    const elsewhere = mkdtempSync(safePath.join(out, 'elsewhere-'));
    link(skip, elsewhere, base);

    expect(() => openArmsRoot({ override: null, subjects: [] })).toThrow(REFUSED);
    expect(readdirSync(elsewhere)).toStrictEqual([]);
  });

  it.skipIf(!POSIX)('refuses a default base anyone else can write into, rather than running under it', () => {
    scratchTmpdir();
    const base = dirname(openArmsRoot({ override: null, subjects: [] }));
    chmodSync(base, 0o777);

    expect(() => openArmsRoot({ override: null, subjects: [] })).toThrow(REFUSED);
    expect(readdirSync(base)).toHaveLength(1);
  });

  it('takes an absolute --arms-dir as the root, creating it owner-only, and accepts it again', () => {
    const chosen = safePath.join(out, 'chosen', 'arms');

    expect(openArmsRoot({ override: chosen, subjects: [] })).toBe(chosen);
    expect(openArmsRoot({ override: chosen, subjects: [] })).toBe(chosen);
    if (POSIX) expect(mode(chosen)).toBe(0o700);
  });

  it('refuses a relative --arms-dir', () => {
    expect(() => openArmsRoot({ override: 'arms', subjects: [] })).toThrow(REFUSED);
  });

  it('refuses an --arms-dir equal to, inside, or containing a subject — and creates nothing there', () => {
    const subject = safePath.join(out, 'workspace', 'app');
    mkdirSyncReal(subject, { recursive: true });

    expect(() => openArmsRoot({ override: subject, subjects: [subject] })).toThrow(/itself/u);
    expect(() => openArmsRoot({ override: safePath.join(subject, '.vat-lab'), subjects: [subject] })).toThrow(/inside/u);
    expect(() => openArmsRoot({ override: safePath.join(out, 'workspace'), subjects: [subject] })).toThrow(/contains/u);
    expect(existsSync(safePath.join(subject, '.vat-lab'))).toBe(false);
  });

  it.skipIf(!POSIX)('refuses a symlinked --arms-dir', ({ skip }) => {
    const elsewhere = mkdtempSync(safePath.join(out, 'elsewhere-'));
    const chosen = safePath.join(out, 'arms');
    link(skip, elsewhere, chosen);

    expect(() => openArmsRoot({ override: chosen, subjects: [] })).toThrow(REFUSED);
  });
});
