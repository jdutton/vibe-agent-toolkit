/**
 * The file helpers of the tree-change primitive: `replaceFile` (temp beside, then
 * rename — a failed write never truncates the file it replaces), `withTempDir` /
 * `disposeTempDir` (always disposed; the work's error wins over a disposal's), and
 * `isTreeChangeResidue`.
 */

import { readdirSync, writeFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import { fsFaultOf } from '../../src/errors/errno-table.js';
import { classifyFsFault, isFsFaultError } from '../../src/errors/fs-fault.js';
import { suppressedFaultsOf } from '../../src/errors/suppressed-faults.js';
import { isVatError, VatError } from '../../src/errors/vat-error.js';
import { safePath, toForwardSlash } from '../../src/path-core.js';
import { normalizedTmpdir } from '../../src/path-utils.js';
import { createSymlink, symlinkCapability } from '../../src/test-helpers.js';
import { PERMISSIONS_ENFORCED } from '../../src/testing/platform-gates.js';
import { disposeTempDir, disposeTempDirAfterFailure, replaceFile, TEMP_DIR_OUTSIDE_TMPDIR_CODE, withTempDir } from '../../src/tree-change/files.js';

import { plant, present, readText, rejectionOf, residueIn, treeChangeSuite } from './tree-change-test-kit.js';

const suite = treeChangeSuite('tree-change-files-');

/** Run `withTempDir` whose work rejects with `failure` while its disposal is refused: what it threw, and the directory it was given. */
async function failBoth(prefix: string, failure: unknown): Promise<{ error: unknown; dir: string }> {
  const refused = { op: 'rm', path: (p: string) => p.includes(prefix), errno: 'EACCES' } as const;
  let dir = '';
  suite.faults(normalizedTmpdir(), [refused, { ...refused }]);
  const error = await rejectionOf(() => withTempDir(prefix, (given) => {
    dir = given;
    return Promise.reject(failure);
  }));
  suite.restoreFaults();
  return { error, dir };
}

describe('replaceFile', () => {
  it('replaces a file\'s bytes, keeping its mode', async () => {
    const root = suite.root();
    const file = safePath.join(root, 'registry.json');
    writeFileSync(file, 'old', { mode: 0o600 });
    await replaceFile(file, 'new');
    expect(readText(file)).toBe('new');
    expect(residueIn(root)).toEqual([]);
  });

  it('creates a file that is not there', async () => {
    const root = suite.root();
    await replaceFile(safePath.join(root, 'fresh.json'), new Uint8Array([123, 125]));
    expect(readText(safePath.join(root, 'fresh.json'))).toBe('{}');
  });

  it('an ENOSPC mid-write leaves the old file byte-equal and no temp beside it', async () => {
    const root = suite.root();
    const file = safePath.join(root, 'registry.json');
    writeFileSync(file, 'the user\'s registry');
    // On the handle's write, after the temp file exists: the open itself succeeds.
    const session = suite.faults(root, [{ op: 'writeFile', path: (p) => p.includes('.vat-staged-'), errno: 'ENOSPC' }]);

    expect(await rejectionOf(() => replaceFile(file, 'x'.repeat(4096)))).toMatchObject({ code: 'ENOSPC' });
    expect(session.fired.map((call) => call.api)).toEqual(['handle']);

    suite.restoreFaults();
    expect(readText(file)).toBe('the user\'s registry');
    expect(residueIn(root)).toEqual([]);
  });

  // A rename over a file needs only its directory's permission, so a temp renamed over a file the
  // user made read-only replaced it anyway — a `settings.json` locked against writes was rewritten.
  // A write in place is refused there; so is the replace, before anything is written.
  it.skipIf(!PERMISSIONS_ENFORCED)('refuses to replace a file its mode makes read-only, as a write in place would be, writing nothing', async () => {
    const root = suite.root();
    const file = safePath.join(root, 'settings.json');
    writeFileSync(file, 'locked', { mode: 0o444 });

    expect(await rejectionOf(() => replaceFile(file, 'new'))).toMatchObject({ code: 'EACCES' });

    expect(readText(file)).toBe('locked');
    expect(residueIn(root)).toEqual([]);
  });

  it('writes through a link to the file it points at, keeping the link', async ({ skip }) => {
    const cap = symlinkCapability();
    if (cap === null) return skip('host cannot create symlinks');
    const root = suite.root();
    plant(root, { 'dotfiles/settings.json': 'old' });
    const link = safePath.join(root, 'settings.json');
    createSymlink(cap, safePath.join(root, 'dotfiles', 'settings.json'), link, 'file');

    await replaceFile(link, 'new');

    expect(readText(safePath.join(root, 'dotfiles', 'settings.json'))).toBe('new');
    expect(readdirSync(root, { withFileTypes: true }).find((e) => e.name === 'settings.json')?.isSymbolicLink()).toBe(true);
  });
});

describe('replaceFile — a refused rename', () => {
  it.skipIf(process.platform === 'win32')('leaves the old file byte-equal and the written temp removed', async () => {
    // Skipped on win32: there EACCES on a rename is contention, retried — pinned in the win32 retry suite.
    const root = suite.root();
    const file = safePath.join(root, 'registry.json');
    writeFileSync(file, 'the user\'s registry');
    suite.faults(root, [{ op: 'rename', path: (p) => p.includes('.vat-staged-'), errno: 'EACCES' }]);

    expect(await rejectionOf(() => replaceFile(file, 'new'))).toMatchObject({ code: 'EACCES' });

    suite.restoreFaults();
    expect(readText(file)).toBe('the user\'s registry');
    expect(residueIn(root)).toEqual([]);
  });
});

describe('withTempDir', () => {
  it('hands work a fresh directory under the temp dir and disposes of it after', async () => {
    let seen = '';
    const outcome = await withTempDir('vat-t13-ok-', (dir) => {
      seen = dir;
      writeFileSync(safePath.join(dir, 'x'), 'x');
      return Promise.resolve(42);
    });
    expect(outcome).toEqual({ value: 42, leftover: undefined });
    expect(seen.startsWith(toForwardSlash(normalizedTmpdir()))).toBe(true);
    expect(present(seen)).toBe(false);
  });

  it('disposes of the directory when work throws, and throws work\'s error', async () => {
    let seen = '';
    const failure = new Error('work failed');
    expect(await rejectionOf(() => withTempDir('vat-t13-fail-', (dir) => {
      seen = dir;
      return Promise.reject(failure);
    }))).toBe(failure);
    expect(present(seen)).toBe(false);
  });

  it('when both fail, the work\'s error is rethrown unchanged and the disposal fault is recorded beside it, off its cause chain', async () => {
    const failure = new Error('work failed');
    const { error, dir } = await failBoth('vat-t13-dispose-', failure);

    expect(error).toBe(failure);
    expect(failure.cause).toBeUndefined();
    const [disposal, ...more] = suppressedFaultsOf(error);
    expect(more).toEqual([]);
    expect(disposal).toMatchObject({ side: 'environment', faultClass: 'refused' });
    expect((disposal as Error).message).toContain(dir);
    expect(await disposeTempDir(dir)).toBeUndefined();
  });

  it('records the disposal fault against a frozen work error, which stays frozen and unchanged', async () => {
    const failure = Object.freeze(new Error('frozen work failure'));
    const { error, dir } = await failBoth('vat-t13-frozen-', failure);

    expect(error).toBe(failure);
    expect(Object.isFrozen(error)).toBe(true);
    expect(suppressedFaultsOf(error)).toHaveLength(1);
    expect(await disposeTempDir(dir)).toBeUndefined();
  });

  it('leaves a work error\'s own classified cause the first fault a cause walk finds', async () => {
    const workFault = classifyFsFault(Object.assign(new Error('EACCES'), { code: 'EACCES', path: '/input/secret.md' }), { side: 'source', origin: 'content', action: 'read the skill' });
    const failure = new VatError('SKILL_PACKAGING_INPUT_INVALID', 'could not read the skill', { cause: workFault });
    const { error, dir } = await failBoth('vat-t13-caused-', failure);

    expect(error).toBe(failure);
    expect((error as Error).cause).toBe(workFault);
    expect(fsFaultOf(error)).toMatchObject({ errno: 'EACCES', path: '/input/secret.md' });
    expect(((workFault as Error).cause as Error).cause).toBeUndefined();
    expect(await disposeTempDir(dir)).toBeUndefined();
  });

  it('records both disposal faults against one error object two runs share', async () => {
    const shared = new Error('shared failure');
    const first = await failBoth('vat-t13-shared-a-', shared);
    const second = await failBoth('vat-t13-shared-b-', shared);

    expect(suppressedFaultsOf(shared).map((fault) => (fault as Error).message)).toEqual([
      expect.stringContaining(first.dir) as string,
      expect.stringContaining(second.dir) as string,
    ]);
    expect(suppressedFaultsOf(new Error('unrelated'))).toEqual([]);
    expect(await disposeTempDir(first.dir)).toBeUndefined();
    expect(await disposeTempDir(second.dir)).toBeUndefined();
  });

  // The work is DONE: a directory the OS will not remove is never its refusal. It comes back
  // beside the value, for the verb to report as a warning next to the work it finished.
  it('when only disposal fails, returns the value with the environment fault naming the directory, and throws nothing', async () => {
    const prefix = 'vat-t13-only-dispose-';
    const refused = { op: 'rm', path: (p: string) => p.includes(prefix), errno: 'EACCES' } as const;
    let seen = '';
    suite.faults(normalizedTmpdir(), [refused, { ...refused }]);

    const outcome = await withTempDir(prefix, (dir) => {
      seen = dir;
      return Promise.resolve('uploaded');
    });
    suite.restoreFaults();

    expect(outcome.value).toBe('uploaded');
    expect(isFsFaultError(outcome.leftover) && outcome.leftover.side === 'environment').toBe(true);
    expect((outcome.leftover as Error).message).toContain(seen);
    expect(await disposeTempDir(seen)).toBeUndefined();
  });
});

/**
 * ⛔ Never aimed at the real temp directory: if the guard were gone, the removal would make
 * and delete whatever it was handed. A scratch tree stands in — `TMPDIR` (and Windows' `TEMP`
 * / `TMP`) point at `scratch/tmp`, and the directories the guard must refuse are inside the
 * scratch tree, so a missing guard could only ever delete the test's own files.
 */
function stubTempRoot(): { tmp: string; outside: string } {
  const scratch = suite.root();
  plant(scratch, { 'tmp/keep.md': 'k', 'outside/data.md': 'd' });
  const tmp = safePath.join(scratch, 'tmp');
  for (const name of ['TMPDIR', 'TEMP', 'TMP']) vi.stubEnv(name, tmp);
  return { tmp, outside: safePath.join(scratch, 'outside') };
}

describe('disposeTempDir', () => {
  it('refuses a directory outside the temp directory, removing nothing', async () => {
    const { outside } = stubTempRoot();
    const error = await rejectionOf(() => disposeTempDir(outside));
    expect(isVatError(error, TEMP_DIR_OUTSIDE_TMPDIR_CODE)).toBe(true);
    expect((error as Error).message).toContain(outside);
    expect(readText(safePath.join(outside, 'data.md'))).toBe('d');
  });

  it('refuses the temp directory itself, removing nothing', async () => {
    const { tmp } = stubTempRoot();
    expect(toForwardSlash(normalizedTmpdir())).toBe(tmp);
    expect(isVatError(await rejectionOf(() => disposeTempDir(tmp)), TEMP_DIR_OUTSIDE_TMPDIR_CODE)).toBe(true);
    expect(readText(safePath.join(tmp, 'keep.md'))).toBe('k');
  });

  it('answers undefined once the directory is gone, and for one never there', async () => {
    const root = suite.root();
    plant(root, { 'd/x.txt': 'x' });
    expect(await disposeTempDir(safePath.join(root, 'd'))).toBeUndefined();
    expect(present(safePath.join(root, 'd'))).toBe(false);
    expect(await disposeTempDir(safePath.join(root, 'never'))).toBeUndefined();
  });

  it('answers why not when the OS refuses, naming the directory', async () => {
    const root = suite.root();
    plant(root, { 'd/x.txt': 'x' });
    const dir = safePath.join(root, 'd');
    const refused = { op: 'rm', path: (p: string) => p === dir, errno: 'EACCES' } as const;
    suite.faults(root, [refused, { ...refused }]);
    const leftover = await disposeTempDir(dir);
    expect(isFsFaultError(leftover) && leftover.side === 'environment').toBe(true);
    expect((leftover as Error).message).toContain(dir);
  });
});

describe('disposeTempDirAfterFailure', () => {
  it('disposes of the directory and records nothing against the failure', async () => {
    const root = suite.root();
    plant(root, { 'd/x.txt': 'x' });
    const failure = new Error('work failed');
    await disposeTempDirAfterFailure(safePath.join(root, 'd'), failure);
    expect(present(safePath.join(root, 'd'))).toBe(false);
    expect(suppressedFaultsOf(failure)).toEqual([]);
  });

  it('records a refused disposal beside the failure, which stays unchanged, naming the directory', async () => {
    const root = suite.root();
    plant(root, { 'd/x.txt': 'x' });
    const dir = safePath.join(root, 'd');
    const failure = Object.freeze(new Error('work failed'));
    const refused = { op: 'rm', path: (p: string) => p === dir, errno: 'EACCES' } as const;
    suite.faults(root, [refused, { ...refused }]);

    await disposeTempDirAfterFailure(dir, failure);
    suite.restoreFaults();

    expect(failure.cause).toBeUndefined();
    const [disposal, ...more] = suppressedFaultsOf(failure);
    expect(more).toEqual([]);
    expect(disposal).toMatchObject({ side: 'environment', faultClass: 'refused' });
    expect((disposal as Error).message).toContain(dir);
  });

  it('refuses a directory outside the temp directory, removing nothing', async () => {
    const { outside } = stubTempRoot();
    const error = await rejectionOf(() => disposeTempDirAfterFailure(outside, new Error('work failed')));
    expect(isVatError(error, TEMP_DIR_OUTSIDE_TMPDIR_CODE)).toBe(true);
    expect(readText(safePath.join(outside, 'data.md'))).toBe('d');
  });
});
