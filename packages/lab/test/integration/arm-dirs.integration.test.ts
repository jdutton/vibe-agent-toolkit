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
  armRefusal,
  armDirectoriesAt,
  armPlacementRefusal,
  closeArmsRoot,
  openArmsRoot,
  openOutDirectory,
  prepareArmDirectories,
  resetArmHome,
  resetColdArm,
  samePath,
  type ArmsRootHandle,
  underArmsRoot,
} from '../../src/harness/arm-dirs.js';

/** An ending with nothing kept past the capture: the whole default run directory goes. */
const WHOLE = { keep: false, kept: null } as const;

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

    const first = openArmsRoot({ override: null, subjects: [subject] }).path;
    const second = openArmsRoot({ override: null, subjects: [subject] }).path;

    expect(first).not.toBe(second);
    const base = dirname(first);
    expect(dirname(second)).toBe(base);
    expect(basename(base)).toMatch(/^vat-lab-arms-[\w.-]+$/u);
    expect(normalizePath(dirname(base), out)).toBe(tmp);
    expect(readdirSync(first)).toStrictEqual(['.vat-lab-root']);
    if (POSIX) {
      expect(mode(base)).toBe(0o700);
      expect(mode(first)).toBe(0o700);
    }
  });

  it('refuses a default root whose temp directory lies inside a subject — before creating or marking anything', () => {
    const subject = mkdtempSync(safePath.join(out, 'subject-'));
    const tmp = mkdirSyncReal(safePath.join(subject, 'tmp'));
    for (const name of ['TMPDIR', 'TEMP', 'TMP']) vi.stubEnv(name, tmp);

    expect(() => openArmsRoot({ override: null, subjects: [subject] })).toThrow(/lies inside the subject/u);
    expect(readdirSync(tmp)).toStrictEqual([]);
  });

  it.skipIf(!POSIX)('refuses a default base that is a symlink, creating nothing through it', ({ skip }) => {
    scratchTmpdir();
    const base = dirname(openArmsRoot({ override: null, subjects: [] }).path);
    rmSync(base, { recursive: true });
    const elsewhere = mkdtempSync(safePath.join(out, 'elsewhere-'));
    link(skip, elsewhere, base);

    expect(() => openArmsRoot({ override: null, subjects: [] })).toThrow(REFUSED);
    expect(readdirSync(elsewhere)).toStrictEqual([]);
  });

  it.skipIf(!POSIX)('refuses a default base anyone else can write into, rather than running under it', () => {
    scratchTmpdir();
    const base = dirname(openArmsRoot({ override: null, subjects: [] }).path);
    chmodSync(base, 0o777);

    expect(() => openArmsRoot({ override: null, subjects: [] })).toThrow(REFUSED);
    expect(readdirSync(base)).toHaveLength(1);
  });

  it('takes an absolute --arms-dir as the root, creating it owner-only and marked, and accepts it again', () => {
    const chosen = safePath.join(out, 'chosen', 'arms');

    expect(openArmsRoot({ override: chosen, subjects: [] })).toStrictEqual({ path: chosen, temporary: false });
    expect(openArmsRoot({ override: chosen, subjects: [] }).path).toBe(chosen);
    expect(readdirSync(chosen)).toStrictEqual(['.vat-lab-root']);
    if (POSIX) expect(mode(chosen)).toBe(0o700);
  });

  it('refuses an existing, non-empty --arms-dir the lab did not make — writing nothing into it, chmodding nothing', () => {
    const chosen = safePath.join(out, 'checkout');
    const victim = foreignTree(chosen);
    chmodSync(chosen, 0o755);

    expect(() => openArmsRoot({ override: chosen, subjects: [] })).toThrow(/not empty and carries no \.vat-lab-root/u);
    expect(readFileSync(victim, 'utf-8')).toBe('not the lab’s');
    expect(readdirSync(chosen)).toStrictEqual(['home']);
    if (POSIX) expect(mode(chosen)).toBe(0o755);
  });

  it('adopts an existing EMPTY --arms-dir by marking it, and never chmods it — the lab did not create it', () => {
    const chosen = mkdirSyncReal(safePath.join(out, 'empty'), { mode: 0o755 });
    chmodSync(chosen, 0o755);

    expect(openArmsRoot({ override: chosen, subjects: [] }).path).toBe(chosen);
    expect(readdirSync(chosen)).toStrictEqual(['.vat-lab-root']);
    if (POSIX) expect(mode(chosen)).toBe(0o755);
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

describe('closeArmsRoot', () => {
  it('removes a default run directory when the capture ends, and says so', async () => {
    scratchTmpdir();
    const root = openArmsRoot({ override: null, subjects: [] });
    prepareArmDirectories(armDirectories({ root: root.path, build: 'cand', arm: 'C', state: 'cold' }));

    expect(await closeArmsRoot(root, WHOLE)).toBe(`Removed arms under ${root.path}`);
    expect(existsSync(root.path)).toBe(false);
  });

  it('keeps it when asked, and says where', async () => {
    scratchTmpdir();
    const root = openArmsRoot({ override: null, subjects: [] });

    expect(await closeArmsRoot(root, { keep: true, kept: null })).toBe(`Kept arms under ${root.path}`);
    expect(existsSync(root.path)).toBe(true);
  });

  it('never removes an --arms-dir the operator named', async () => {
    const root = openArmsRoot({ override: safePath.join(out, 'named'), subjects: [] });

    expect(await closeArmsRoot(root, WHOLE)).toBe(`Kept arms under ${root.path}`);
    expect(existsSync(root.path)).toBe(true);
  });

  it('refuses to remove a run directory whose marker is gone — it is no longer provably the lab’s', async () => {
    scratchTmpdir();
    const root = openArmsRoot({ override: null, subjects: [] });
    rmSync(safePath.join(root.path, '.vat-lab-root'));
    writeFileSync(safePath.join(root.path, 'keep.txt'), 'x');

    await expect(closeArmsRoot(root, WHOLE)).rejects.toThrow(REFUSED);
    expect(readFileSync(safePath.join(root.path, 'keep.txt'), 'utf-8')).toBe('x');
  });
});

/**
 * Run a body under a default run directory, recording what is said.
 *
 * @param body - The capture
 * @returns What was said, and the run directory's path
 */
async function underDefaultRoot(body: (root: ArmsRootHandle) => Promise<void>): Promise<{ readonly said: string[]; readonly run: string }> {
  const said: string[] = [];
  let run = '';
  await underArmsRoot({ override: null, subjects: [] }, false, (line) => said.push(line), (root) => {
    run = root.path;
    return body(root);
  });
  return { said, run };
}

/**
 * Lay out a prepared clone under a run directory, holding a file of the arm marker's name.
 *
 * @param root - The run directory
 * @returns The clone
 */
function fakeClone(root: string): string {
  prepareArmDirectories(armDirectories({ root, build: 'cand', arm: 'C', state: 'cold' }));
  const clone = mkdirSyncReal(safePath.join(root, 'clone'));
  writeFileSync(safePath.join(clone, 'README.md'), 'cloned');
  // A subject may track a file of the arm marker's name; its clone is still not an arm.
  writeFileSync(safePath.join(clone, '.vat-lab-arm'), 'tracked by the subject');
  return clone;
}

/** @returns Every entry of the default arms base, sorted */
function baseEntries(run: string): string[] {
  return readdirSync(dirname(run)).sort((a, b) => a.localeCompare(b));
}

describe('underArmsRoot — only a child whose report was written outlives a default run directory', () => {
  it('moves the child beside the run directory, hands write that path, removes the run directory whole, and names the child', async () => {
    scratchTmpdir();
    const handed: string[] = [];

    const { said, run } = await underDefaultRoot(async (root) => {
      fakeClone(root.path);
      await root.keepChild('clone', (kept) => handed.push(kept));
    });

    const kept = safePath.join(dirname(run), `clone-${basename(run).slice('run-'.length)}`);
    expect(handed).toStrictEqual([kept]);
    expect(said.at(-1)).toBe(`Removed arms under ${run}\nPrepared clone kept at ${kept}; remove it when done`);
    expect(baseEntries(run)).toStrictEqual([basename(kept)]);
    expect(readFileSync(safePath.join(kept, 'README.md'), 'utf-8')).toBe('cloned');
  });

  it('removes the clone with the run directory when no report names it, and says nothing of a clone', async () => {
    scratchTmpdir();

    const { said, run } = await underDefaultRoot(async (root) => {
      fakeClone(root.path);
    });

    expect(said.at(-1)).toBe(`Removed arms under ${run}`);
    expect(baseEntries(run)).toStrictEqual([]);
  });

  it('moves the child back when the report cannot be written, so it ends with the run directory', async () => {
    scratchTmpdir();
    const said: string[] = [];
    let run = '';

    const thrown = underArmsRoot({ override: null, subjects: [] }, false, (line) => said.push(line), async (root) => {
      run = root.path;
      fakeClone(root.path);
      await root.keepChild('clone', () => {
        throw new Error('the report write failed');
      });
    });

    await expect(thrown).rejects.toThrow('the report write failed');
    expect(said.at(-1)).toBe(`Removed arms under ${run}`);
    expect(baseEntries(run)).toStrictEqual([]);
  });

  it('refuses to move the child over something already at the kept path, writes nothing, and leaves that occupant', async () => {
    scratchTmpdir();
    let occupant = '';
    const handed: string[] = [];

    const thrown = underDefaultRoot(async (root) => {
      fakeClone(root.path);
      occupant = foreignTree(safePath.join(dirname(root.path), `clone-${basename(root.path).slice('run-'.length)}`));
      await root.keepChild('clone', (kept) => handed.push(kept));
    });

    await expect(thrown).rejects.toThrow(REFUSED);
    expect(handed).toStrictEqual([]);
    expect(readFileSync(occupant, 'utf-8')).toBe('not the lab’s');
    expect(baseEntries(dirname(dirname(occupant)))).toStrictEqual([basename(dirname(dirname(occupant)))]);
  });

  it('keeps the child where it is under --keep-arms and under an --arms-dir, both kept whole', async () => {
    scratchTmpdir();
    const named = safePath.join(out, 'named');
    for (const [request, keep] of [[{ override: null, subjects: [] }, true], [{ override: named, subjects: [] }, false]] as const) {
      const said: string[] = [];
      let run = '';
      let clone = '';
      const handed: string[] = [];
      await underArmsRoot(request, keep, (line) => said.push(line), async (root) => {
        run = root.path;
        clone = fakeClone(root.path);
        await root.keepChild('clone', (kept) => handed.push(kept));
      });
      expect(handed).toStrictEqual([clone]);
      expect(said.at(-1)).toBe(`Kept arms under ${run}\nPrepared clone kept at ${clone}; remove it when done`);
      expect(readFileSync(safePath.join(clone, 'README.md'), 'utf-8')).toBe('cloned');
    }
  });
});

/** A body that makes the cleanup fail: the root's marker goes, so the root is no longer provably the lab's. */
function unmark(path: string): void {
  rmSync(safePath.join(path, '.vat-lab-root'));
}

describe('samePath — one directory, however it is spelled', () => {
  it('is true through a trailing slash, a dot segment and a link, and false for a sibling', ({ skip }) => {
    const clone = mkdirSyncReal(safePath.join(out, 'clone'));
    const viaLink = safePath.join(out, 'link');
    link(skip, clone, viaLink);

    expect(samePath(`${clone}/`, clone, clone)).toBe(true);
    expect(samePath(safePath.join(out, '.', 'clone'), clone, clone)).toBe(true);
    expect(samePath(viaLink, clone, clone)).toBe(true);
    expect(samePath(safePath.join(out, 'other'), clone, clone)).toBe(false);
  });
});

describe('underArmsRoot — a cleanup failure never costs the capture', () => {

  it('keeps what a completed body published when the cleanup then fails, and reports the cleanup', async () => {
    scratchTmpdir();
    const report = safePath.join(out, 'report.json');
    const said: string[] = [];

    await expect(
      underArmsRoot({ override: null, subjects: [] }, false, (line) => said.push(line), async ({ path }) => {
        writeFileSync(report, '{}');
        unmark(path);
      }),
    ).rejects.toThrow(/carries no \.vat-lab-root/u);
    expect(readFileSync(report, 'utf-8')).toBe('{}');
    expect(said[0]).toMatch(/^Arms under /u);
  });

  it('reports both when the capture threw and the cleanup failed too — the capture first, under its own code', async () => {
    scratchTmpdir();

    const thrown = await underArmsRoot({ override: null, subjects: [] }, false, () => undefined, ({ path }) => {
      unmark(path);
      return Promise.reject(new Error('the capture broke'));
    }).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message.startsWith('the capture broke\n')).toBe(true);
    expect(message).toMatch(/ending the arms root failed too: .*carries no \.vat-lab-root/u);
    expect(thrown).not.toHaveProperty('code');
  });

  it('keeps an arm refusal a refusal when the cleanup fails after it', async () => {
    scratchTmpdir();

    const thrown = underArmsRoot({ override: null, subjects: [] }, false, () => undefined, ({ path }) => {
      unmark(path);
      return Promise.reject(armRefusal('the arm refused'));
    });

    await expect(thrown).rejects.toThrow(REFUSED);
    await expect(thrown).rejects.toThrow(/^the arm refused\n/u);
  });

  it.for([
    { what: 'a system error', original: Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' }), code: 'ENOENT' },
    { what: 'an arm refusal', original: armRefusal('the arm refused'), code: ARM_REFUSED_CODE },
  ])('keeps $what’s code, the capture as cause and the cleanup as second, when the cleanup fails after it', async ({ original, code }) => {
    scratchTmpdir();

    const thrown = await underArmsRoot({ override: null, subjects: [] }, false, () => undefined, ({ path }) => {
      unmark(path);
      return Promise.reject(original);
    }).catch((error: unknown) => error);

    expect(thrown).toHaveProperty('code', code);
    expect(thrown).toHaveProperty('cause', original);
    expect(thrown).toHaveProperty('second', expect.objectContaining({ code: ARM_REFUSED_CODE }));
  });

  it('rethrows the capture’s own error when the cleanup succeeds', async () => {
    scratchTmpdir();
    const failure = new Error('the capture broke');

    await expect(underArmsRoot({ override: null, subjects: [] }, false, () => undefined, () => Promise.reject(failure))).rejects.toBe(failure);
  });
});

describe('openOutDirectory — the one gate every --out goes through', () => {
  it('creates an absent --out owner-only', () => {
    const chosen = safePath.join(out, 'reports', 'here');

    expect(openOutDirectory(chosen, [])).toBe(chosen);
    if (POSIX) expect(mode(chosen)).toBe(0o700);
  });

  it('writes into an existing --out without chmodding it — the lab did not create it', () => {
    const chosen = mkdirSyncReal(safePath.join(out, 'shared'), { mode: 0o755 });
    chmodSync(chosen, 0o755);

    expect(openOutDirectory(chosen, [])).toBe(chosen);
    if (POSIX) expect(mode(chosen)).toBe(0o755);
  });

  it('refuses an --out that IS a subject — `--out .` from the subject root — touching nothing', () => {
    const subject = mkdirSyncReal(safePath.join(out, 'subject'), { mode: 0o755 });
    chmodSync(subject, 0o755);

    expect(() => openOutDirectory(subject, [subject])).toThrow(/is the subject/u);
    expect(readdirSync(subject)).toStrictEqual([]);
    if (POSIX) expect(mode(subject)).toBe(0o755);
  });

  it.skipIf(POSIX)('refuses a JUNCTION as --out and as --arms-dir on Windows, writing nothing through it', ({ skip }) => {
    const elsewhere = mkdtempSync(safePath.join(out, 'elsewhere-'));
    const outLink = safePath.join(out, 'out-junction');
    const armsLink = safePath.join(out, 'arms-junction');
    const capability = symlinkCapability() ?? skip();
    createSymlink(capability, elsewhere, outLink, 'junction');
    createSymlink(capability, elsewhere, armsLink, 'junction');

    expect(() => openOutDirectory(outLink, [])).toThrow(REFUSED);
    expect(() => openArmsRoot({ override: armsLink, subjects: [] })).toThrow(REFUSED);
    expect(readdirSync(elsewhere)).toStrictEqual([]);
  });

  it.skipIf(!POSIX)('refuses a symlinked --out', ({ skip }) => {
    const elsewhere = mkdtempSync(safePath.join(out, 'elsewhere-'));
    const chosen = safePath.join(out, 'out-link');
    link(skip, elsewhere, chosen);

    expect(() => openOutDirectory(chosen, [])).toThrow(REFUSED);
  });
});
