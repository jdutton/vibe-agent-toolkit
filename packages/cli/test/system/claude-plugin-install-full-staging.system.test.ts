/**
 * `vat claude plugin install` and `vat skills install` from an archive, with `$TMPDIR` on a filesystem too
 * small for the extraction: the disk VAT stages on giving out is the run not
 * finishing (`RUN_INCOMPLETE`), never an install. node-tar reports a failed
 * entry write as a warning and resolves, so a `.tgz` used to install a TRUNCATED
 * file, exit 0, `status: ok`.
 *
 * ⚠️ darwin only, and only where macOS will make a RAM disk: a real full
 * filesystem is the only honest fixture (an injected errno never shows what the
 * archive library does with it), and only macOS lets an unprivileged user make
 * and mount one. Linux and Windows CI cannot, so they skip.
 */
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import { basename, dirname } from 'node:path';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { safeExecResult } from '@vibe-agent-toolkit/utils/process';
import AdmZip from 'adm-zip';
import * as tar from 'tar';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createTempDirTracker, executeCliAndParseYaml, fakeHomeEnv, getBinPath } from './test-common.js';

/** Twice the volume, random so no filesystem can compress it: no extraction of it can finish. */
const PAYLOAD_BYTES = 6 * 1024 * 1024;
/** 3 MiB, in 512-byte sectors. */
const VOLUME_SECTORS = '6144';

/** A small HFS+ RAM disk mounted at `mountPoint`, or `undefined` where macOS will not make one (a sandbox). */
function mountSmallVolume(mountPoint: string): (() => void) | undefined {
  if (process.platform !== 'darwin') return undefined;
  const attach = safeExecResult('hdiutil', ['attach', '-nomount', `ram://${VOLUME_SECTORS}`]);
  const device = attach.success ? attach.stdout.toString().trim().split(/\s+/)[0] : undefined;
  if (device === undefined) return undefined;
  const detach = (): void => {
    safeExecResult('umount', [mountPoint]);
    safeExecResult('hdiutil', ['detach', device, '-force']);
  };
  if (!safeExecResult('newfs_hfs', ['-v', 'vat-full', device]).success || !safeExecResult('mount', ['-t', 'hfs', '-o', 'nobrowse', device, mountPoint]).success) {
    detach();
    return undefined;
  }
  return detach;
}

/**
 * Run `vat <verb...> <archive> <after...>` with `$TMPDIR` on `volume` and assert it was refused
 * as the run's (`RUN_INCOMPLETE`, naming the staging path) with no skill `installed` under HOME.
 */
async function expectRunIncomplete(
  binPath: string,
  volume: string,
  command: { verb: string[]; archive: string; after?: string[] },
  installed: string,
): Promise<void> {
  const { verb, archive, after = [] } = command;
  const home = safePath.join(dirname(archive), `home-${verb.join('-')}-${basename(archive)}`);
  mkdirSyncReal(home);
  const { result, parsed } = await executeCliAndParseYaml(binPath, [...verb, archive, ...after], {
    env: { ...fakeHomeEnv(home), TMPDIR: volume, TEMP: volume, TMP: volume },
  });

  expect(result.status, JSON.stringify(parsed)).toBe(2);
  expect(parsed).toMatchObject({ status: 'error', error: { code: 'RUN_INCOMPLETE' } });
  expect(String((parsed['error'] as { message?: unknown } | undefined)?.message)).toContain(volume);
  expect(fs.existsSync(safePath.join(home, '.claude', 'skills', installed))).toBe(false);
}

/** An npm-pack-shaped tarball declaring one skill `big` whose payload no extraction onto the volume can hold. */
async function bigTarball(fixtures: string): Promise<string> {
  const pkg = safePath.join(fixtures, 'tgz-pkg');
  const skill = safePath.join(pkg, 'dist', 'skills', 'big');
  mkdirSyncReal(skill, { recursive: true });
  fs.writeFileSync(safePath.join(pkg, 'package.json'), JSON.stringify({ name: '@test/big', version: '1.0.0', vat: { skills: ['big'] } }));
  fs.writeFileSync(safePath.join(skill, 'SKILL.md'), '---\nname: big\ndescription: Says hello to the user.\n---\n\n# big\n');
  fs.writeFileSync(safePath.join(skill, 'payload.bin'), randomBytes(PAYLOAD_BYTES));
  const archive = safePath.join(fixtures, 'big-1.0.0.tgz');
  await tar.create({ gzip: true, file: archive, cwd: pkg, prefix: 'package' }, ['.']);
  return archive;
}

describe('archive installs with $TMPDIR on a full filesystem (system test)', () => {
  const binPath = getBinPath(import.meta.url);
  const { createTempDir, cleanupTempDirs } = createTempDirTracker('vat-plugin-install-full-');
  let fixtures: string;
  let volume: string;
  let detach: (() => void) | undefined;

  beforeAll(() => {
    fixtures = createTempDir();
    volume = safePath.join(fixtures, 'volume');
    mkdirSyncReal(volume);
    detach = mountSmallVolume(volume);
  });
  afterAll(() => {
    detach?.();
    cleanupTempDirs();
  });
  afterEach(() => {
    // Every lane removes its staging directory; a leftover would fill the volume for the next case.
    expect(fs.readdirSync(volume).filter((entry) => entry.startsWith('vat-'))).toEqual([]);
  });

  it.for([
    ['claude plugin install', ['claude', 'plugin', 'install'], []],
    ['skills install', ['skills', 'install'], ['--target', 'claude', '--scope', 'user']],
  ] as const)('%s: refuses a .tgz it runs out of space extracting as RUN_INCOMPLETE, installing nothing', async ([, verb, after], { skip }) => {
    if (detach === undefined) skip();

    await expectRunIncomplete(binPath, volume, { verb: [...verb], archive: await bigTarball(fixtures), after: [...after] }, 'big');
  });

  it('refuses a .zip it runs out of space extracting as RUN_INCOMPLETE, installing nothing', async ({ skip }) => {
    if (detach === undefined) skip();
    const zip = new AdmZip();
    zip.addFile('SKILL.md', Buffer.from('# huge\n'));
    zip.addFile('payload.bin', randomBytes(PAYLOAD_BYTES));
    const archive = safePath.join(fixtures, 'huge.zip');
    zip.writeZip(archive);

    await expectRunIncomplete(binPath, volume, { verb: ['claude', 'plugin', 'install'], archive }, 'huge');
  });
});
