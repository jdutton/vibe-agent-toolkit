/**
 * `vat cache clear` publishes the report envelope — observed through the built CLI.
 *
 * ⛔ Never against the real cache. The command deletes `<tmpdir>/.vat-cache`,
 * and that tree is shared with every other VAT on the machine — this suite's
 * own sibling test files included. Every run here redirects the child's temp
 * root (`TMPDIR` on POSIX, `TEMP` / `TMP` on Windows) into a directory the
 * test owns, so the tree it clears is one it built.
 */

import { chmodSync, existsSync, readdirSync } from 'node:fs';

import { ExitCode } from '@vibe-agent-toolkit/schema';
import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { CANNOT_DENY_READS, type FaultFsSpec } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import yaml from 'yaml';

import { CACHE_CLEAR_REPORT_SCHEMA, type CacheClearReport } from '../../src/commands/cache/clear-schema.js';

import { cleanupTestTempDir, createTestTempDir, executeCli, getBinPath, getMonorepoRoot, writeFileTree } from './test-common.js';

const binPath = getBinPath(import.meta.url);
/** The in-process fault injector, loaded into the spawned binary before it runs (`VAT_FAULT_FS` says what to fail). */
const preload = safePath.join(getMonorepoRoot(import.meta.url), 'packages', 'utils', 'dist', 'testing', 'fault-fs-preload.js');

/** Mode bits: a directory whose entries cannot be removed, one nothing may read, and the restore. */
const UNWRITABLE = 0o555;
const UNREADABLE = 0o000;
const RESTORED = 0o755;

let tempDir: string;
/** Directories a case locked, restored before cleanup — a locked directory is not removable. */
const locked: string[] = [];

/** A fresh temp root for one run, and the `.vat-cache` inside it. */
function tempRoot(name: string): { root: string; cacheDir: string } {
  const root = safePath.join(tempDir, name);
  mkdirSyncReal(root, { recursive: true });
  return { root, cacheDir: safePath.join(root, '.vat-cache') };
}

/**
 * Run `vat cache clear` with its temp root redirected to `root` (and, given `faults`, under the
 * fault injector), and read its document with the published schema.
 */
async function clearUnder(root: string, faults?: FaultFsSpec['faults']): Promise<{ status: number | null; stderr: string; report: CacheClearReport }> {
  const injected = faults === undefined ? {} : { nodeArgs: ['--import', preload] };
  const spec: FaultFsSpec = { within: root, faults: faults ?? [] };
  const env = { TMPDIR: root, TEMP: root, TMP: root, ...(faults === undefined ? {} : { VAT_FAULT_FS: JSON.stringify(spec) }) };
  const result = await executeCli(binPath, ['cache', 'clear'], { cwd: tempDir, env, ...injected });
  return { status: result.status, stderr: result.stderr, report: CACHE_CLEAR_REPORT_SCHEMA.parse(yaml.parse(result.stdout)) };
}

/** The refusal code a document carries, or `undefined` when it is not the error branch. */
function refusalOf(report: CacheClearReport): string | undefined {
  return report.status === 'error' ? report.error.code : undefined;
}

describe('vat cache clear (system test)', () => {
  beforeAll(() => {
    tempDir = createTestTempDir('vat-cache-clear-');
  });

  afterAll(() => {
    for (const dir of locked) chmodSync(dir, RESTORED);
    cleanupTestTempDir(tempDir);
  });

  it('a clear that removed everything is ok, exit 0, and says what went', async () => {
    const { root, cacheDir } = tempRoot('ok');
    writeFileTree(cacheDir, { 'external-links.json': '{}', 'ns/parse/ab/facts.json': '{"x":1}' });

    const { status, stderr, report } = await clearUnder(root);

    expect(status, stderr).toBe(ExitCode.OK);
    expect(report.status).toBe('ok');
    expect(report.examined).toBe(1);
    expect(report.data).toEqual({ cacheDir: expect.any(String), existed: true, removed: ['external-links.json', 'ns'], entriesRemoved: 2, bytesRemoved: 9 });
    expect(readdirSync(root)).toEqual([]);
  });

  it('a cache that is not there is ok, exit 0, with existed: false', async () => {
    const { root } = tempRoot('absent');

    const { status, stderr, report } = await clearUnder(root);

    expect(status, stderr).toBe(ExitCode.OK);
    expect(report).toMatchObject({ status: 'ok', examined: 1, data: { existed: false, removed: [] } });
  });

  it.skipIf(CANNOT_DENY_READS)('a cache holding a read-only directory is removed whole, exit 0', async () => {
    // A directory whose entries could not be unlinked used to stop the delete part-way.
    const { root, cacheDir } = tempRoot('read-only');
    writeFileTree(cacheDir, { 'a.json': '{}', 'stuck/inner.json': '{}' });
    const stuck = safePath.join(cacheDir, 'stuck');
    chmodSync(stuck, UNWRITABLE);

    const { status, stderr, report } = await clearUnder(root);

    expect(status, stderr).toBe(ExitCode.OK);
    expect(report.data).toMatchObject({ existed: true, removed: ['a.json', 'stuck'], entriesRemoved: 2 });
    expect(readdirSync(root)).toEqual([]);
  });

  it('a removal the OS stops once the cache left its path is RUN_INCOMPLETE with the clear\'s data and a warning naming the rest', async () => {
    const { root, cacheDir } = tempRoot('stopped');
    writeFileTree(cacheDir, { 'a.json': '{}', 'ns/inner.json': '{}' });

    const { status, stderr, report } = await clearUnder(root, [{ family: 'remove', op: 'rm', pathIncludes: '.previous', errno: 'EBUSY' }]);

    expect(status, stderr).toBe(ExitCode.ERROR);
    expect(refusalOf(report)).toBe('RUN_INCOMPLETE');
    expect(report.data).toMatchObject({ existed: true, removed: ['a.json', 'ns'], entriesRemoved: 2 });
    expect(existsSync(cacheDir)).toBe(false);
    const parked = readdirSync(root).find((name) => name.endsWith('.previous'));
    expect(parked, readdirSync(root).join(', ')).toBeDefined();
    expect(report.findings).toMatchObject([{ code: 'TREE_CLEANUP_INCOMPLETE', severity: 'warning', link: expect.stringContaining(parked ?? '-') }]);
  });

  it.skipIf(CANNOT_DENY_READS)('a cache root the OS will not list is RUN_INCOMPLETE, exit 2, nothing removed', async () => {
    const { root, cacheDir } = tempRoot('unreadable');
    writeFileTree(cacheDir, { 'a.json': '{}' });
    chmodSync(cacheDir, UNREADABLE);
    locked.push(cacheDir);

    const { status, stderr, report } = await clearUnder(root);

    expect(status, stderr).toBe(ExitCode.ERROR);
    expect(refusalOf(report)).toBe('RUN_INCOMPLETE');
    expect(report.data).toBeNull();
    chmodSync(cacheDir, RESTORED);
    expect(readdirSync(cacheDir)).toEqual(['a.json']);
  });
});
