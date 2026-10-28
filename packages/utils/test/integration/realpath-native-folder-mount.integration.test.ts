/**
 * The native-`ENOENT` → JS-walk fallback, on a REAL host answer rather than a stubbed one.
 *
 * Windows' native realpath asks `GetFinalPathNameByHandleW` for the DOS name, and a volume mounted
 * into a folder with no drive letter has none: the call fails `ERROR_PATH_NOT_FOUND`, which libuv
 * reports as `ENOENT`, for a file that exists. That is the case the fallback rule
 * (`nativeAnswerNeedsJsWalk`) is for, so this suite mounts such a volume — a small VHD, through
 * `diskpart`, which a Windows CI runner (an administrator) can do — and asks.
 *
 * The answer is checked against the path the suite itself built (the mount folder sits under a
 * canonical temp directory, so the file's real path is known without asking any realpath), never
 * against another realpath's answer. Skipped off Windows; on a developer host that cannot mount a
 * VHD (no `diskpart`, no elevation) it skips and says why, but on the Windows CI leg (`CI` set) a
 * mount that fails is a failure — the runner is an administrator, and a skip there would leave the
 * fallback unproven under a green gate. A host that answers the folder-mounted volume natively
 * after all still has its answer checked; only then is the fallback itself not exercised.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { mkdirSyncReal, normalizedTmpdir, realpathNative, realpathNativeSync, safePath, toForwardSlash } from '../../src/path-utils.js';

/** Run a `diskpart` script; true when every command in it succeeded. */
function diskpart(scriptDir: string, lines: readonly string[]): boolean {
  const script = path.win32.normalize(safePath.join(scriptDir, `diskpart-${lines.length}-${Date.now()}.txt`));
  writeFileSync(script, `${lines.join('\r\n')}\r\n`);
  const result = spawnSync('diskpart', ['/s', script], { encoding: 'utf8', timeout: 60_000 });
  return result.status === 0;
}

const cleanups: Array<() => void> = [];

afterAll(() => {
  for (const cleanup of cleanups.toReversed()) cleanup();
});

describe.skipIf(process.platform !== 'win32')('realpathNativeSync / realpathNative on a volume mounted into a folder', () => {
  it('answers a file on a folder-mounted volume at its true path (the native realpath calls it absent)', async ({ skip }) => {
    const dir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-folder-mount-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const vhd = path.win32.normalize(safePath.join(dir, 'volume.vhdx'));
    const mount = path.win32.normalize(safePath.join(dir, 'mnt'));
    mkdirSyncReal(mount);

    const mounted = diskpart(dir, [
      `create vdisk file="${vhd}" maximum=16 type=expandable`,
      `select vdisk file="${vhd}"`,
      'attach vdisk',
      'create partition primary',
      'format fs=ntfs quick',
      `assign mount="${mount}"`,
    ]);
    cleanups.push(() => diskpart(dir, [`select vdisk file="${vhd}"`, 'detach vdisk']));
    if (!mounted && process.env['CI'] !== undefined) expect.fail('the Windows CI runner could not mount a VHD into a folder');
    if (!mounted) skip('this host cannot mount a VHD into a folder (no diskpart, or not elevated)');

    const file = safePath.join(mount, 'a.md');
    writeFileSync(file, 'x');
    // The true answer, known independently: the file is where the suite put it.
    const expected = toForwardSlash(file);
    expect(realpathNativeSync(file)).toBe(expected);
    expect(await realpathNative(file)).toBe(expected);
  });
});
