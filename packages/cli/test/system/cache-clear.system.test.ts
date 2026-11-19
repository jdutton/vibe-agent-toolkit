/**
 * `vat cache clear` and `vat cache prune` publish the report envelope — observed through the built CLI.
 *
 * ⛔ Never against the real cache. The commands delete `<tmpdir>/.vat-cache`
 * (or `VAT_CACHE_DIR`) and `<tmpdir>/.vat-link-cache`, and those trees are
 * shared with every other VAT on the machine — this suite's own sibling test
 * files included. Every run here redirects the child's temp root (`TMPDIR` on
 * POSIX, `TEMP` / `TMP` on Windows) into a directory the test owns, and blanks
 * any inherited `VAT_CACHE_DIR` unless the case sets its own, so the tree it
 * removes is one it built.
 */

import { chmodSync, existsSync, readdirSync, writeFileSync } from 'node:fs';

import { VAT_CACHE_DIR_ENV } from '@vibe-agent-toolkit/resources';
import { ExitCode } from '@vibe-agent-toolkit/schema';
import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { CANNOT_DENY_READS, type FaultFsSpec } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import yaml from 'yaml';

import { CACHE_CLEAR_REPORT_SCHEMA, CACHE_PRUNE_REPORT_SCHEMA, type CacheClearReport } from '../../src/commands/cache/clear-schema.js';

import { cleanupTestTempDir, createTestTempDir, executeCli, faultPreloadArgs, getBinPath, writeFileTree } from './test-common.js';

const binPath = getBinPath(import.meta.url);

/** Mode bits: a directory whose entries cannot be removed, one nothing may read, and the restore. */
const UNWRITABLE = 0o555;
const UNREADABLE = 0o000;
const RESTORED = 0o755;

let tempDir: string;
/** Directories a case locked, restored before cleanup — a locked directory is not removable. */
const locked: string[] = [];

/** A fresh temp root for one run, the default `.vat-cache` inside it, and the link cache beside it. */
function tempRoot(name: string): { root: string; cacheDir: string; linkDir: string } {
  const root = safePath.join(tempDir, name);
  mkdirSyncReal(root, { recursive: true });
  return { root, cacheDir: safePath.join(root, '.vat-cache'), linkDir: safePath.join(root, '.vat-link-cache') };
}

/** Run `vat cache <args>` with its temp root redirected to `root`, any extra env, and (given `faults`) the fault injector. */
async function cacheUnder(root: string, args: string[], extraEnv: Record<string, string> = {}, faults?: FaultFsSpec['faults']): Promise<{ status: number | null; stderr: string; stdout: string }> {
  const injected = faults === undefined ? {} : { nodeArgs: faultPreloadArgs(import.meta.url) };
  const spec: FaultFsSpec = { within: root, faults: faults ?? [] };
  const env = { TMPDIR: root, TEMP: root, TMP: root, [VAT_CACHE_DIR_ENV]: '', ...extraEnv, ...(faults === undefined ? {} : { VAT_FAULT_FS: JSON.stringify(spec) }) };
  const result = await executeCli(binPath, ['cache', ...args], { cwd: tempDir, env, ...injected });
  return { status: result.status, stderr: result.stderr, stdout: result.stdout };
}

/** Run `vat cache clear` under `root` and read its document with the published schema. */
async function clearUnder(root: string, faults?: FaultFsSpec['faults'], extraEnv: Record<string, string> = {}): Promise<{ status: number | null; stderr: string; report: CacheClearReport }> {
  const result = await cacheUnder(root, ['clear'], extraEnv, faults);
  return { status: result.status, stderr: result.stderr, report: CACHE_CLEAR_REPORT_SCHEMA.parse(yaml.parse(result.stdout)) };
}

/** The refusal code a document carries, or `undefined` when it is not the error branch. */
function refusalOf(report: { status: string; error?: { code: string } | undefined }): string | undefined {
  return report.status === 'error' ? report.error?.code : undefined;
}

describe('vat cache clear (system test)', () => {
  beforeAll(() => {
    tempDir = createTestTempDir('vat-cache-clear-');
  });

  afterAll(() => {
    for (const dir of locked) chmodSync(dir, RESTORED);
    cleanupTestTempDir(tempDir);
  });

  it('a clear that removed everything is ok, exit 0, and says what went from both locations', async () => {
    const { root, cacheDir, linkDir } = tempRoot('ok');
    writeFileTree(cacheDir, { 'ns/parse/ab/facts.json': '{"x":1}' });
    writeFileTree(linkDir, { 'external-links.json': '{}' });

    const { status, stderr, report } = await clearUnder(root);

    expect(status, stderr).toBe(ExitCode.OK);
    expect(report.status).toBe('ok');
    expect(report.examined).toBe(2);
    expect(report.data).toEqual({
      locations: [
        { cacheDir: expect.stringMatching(/\/\.vat-cache$/u), existed: true, removed: ['ns'], entriesRemoved: 1, bytesRemoved: 7 },
        { cacheDir: expect.stringMatching(/\/\.vat-link-cache$/u), existed: true, removed: ['external-links.json'], entriesRemoved: 1, bytesRemoved: 2 },
      ],
      entriesRemoved: 2,
      bytesRemoved: 9,
    });
    expect(readdirSync(root)).toEqual([]);
  });

  it('a cache that is not there is ok, exit 0, with existed: false', async () => {
    const { root } = tempRoot('absent');

    const { status, stderr, report } = await clearUnder(root);

    expect(status, stderr).toBe(ExitCode.OK);
    expect(report).toMatchObject({ status: 'ok', examined: 2, data: { locations: [{ existed: false, removed: [] }, { existed: false, removed: [] }] } });
  });

  it('refuses a VAT_CACHE_DIR VAT did not tag, USAGE_INVALID, exit 2, and deletes nothing', async () => {
    const { root, linkDir } = tempRoot('untagged');
    const chosen = safePath.join(root, 'project-files');
    writeFileTree(chosen, { 'important.txt': 'keep me' });
    writeFileTree(linkDir, { 'external-links.json': '{}' });

    const { status, stderr, report } = await clearUnder(root, undefined, { [VAT_CACHE_DIR_ENV]: chosen });

    expect(status, stderr).toBe(ExitCode.ERROR);
    expect(refusalOf(report)).toBe('USAGE_INVALID');
    expect(report.data).toBeNull();
    expect(stderr).toContain('CACHEDIR.TAG');
    expect(readdirSync(chosen)).toEqual(['important.txt']);
    expect(existsSync(linkDir)).toBe(true);
  });

  it.skipIf(CANNOT_DENY_READS)('a cache holding a read-only directory is removed whole, exit 0', async () => {
    // A directory whose entries could not be unlinked used to stop the delete part-way.
    const { root, cacheDir } = tempRoot('read-only');
    writeFileTree(cacheDir, { 'a.json': '{}', 'stuck/inner.json': '{}' });
    const stuck = safePath.join(cacheDir, 'stuck');
    chmodSync(stuck, UNWRITABLE);

    const { status, stderr, report } = await clearUnder(root);

    expect(status, stderr).toBe(ExitCode.OK);
    expect(report.data?.locations[0]).toMatchObject({ existed: true, removed: ['a.json', 'stuck'], entriesRemoved: 2 });
    expect(readdirSync(root)).toEqual([]);
  });

  it('a removal the OS stops once the cache left its path is RUN_INCOMPLETE with the clear\'s data and a warning naming the rest', async () => {
    const { root, cacheDir } = tempRoot('stopped');
    writeFileTree(cacheDir, { 'a.json': '{}', 'ns/inner.json': '{}' });

    const { status, stderr, report } = await clearUnder(root, [{ family: 'remove', op: 'rm', pathIncludes: '.previous', errno: 'EBUSY' }]);

    expect(status, stderr).toBe(ExitCode.ERROR);
    expect(refusalOf(report)).toBe('RUN_INCOMPLETE');
    expect(report.data?.locations[0]).toMatchObject({ existed: true, removed: ['a.json', 'ns'], entriesRemoved: 2 });
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

describe('vat cache prune (system test)', () => {
  beforeAll(() => {
    tempDir = createTestTempDir('vat-cache-prune-');
  });

  afterAll(() => {
    cleanupTestTempDir(tempDir);
  });

  it('keeps a VAT_CACHE_DIR it tagged on first use and prunes an older namespace from it, honouring --dry-run', async () => {
    const { root } = tempRoot('ci');
    const ciCache = safePath.join(root, 'ci-cache');

    // A real run creates and tags the root, as CI's first run would.
    writeFileTree(tempDir, { 'docs/README.md': '# Hello\n\nA document to parse.\n' });
    const validate = await executeCli(binPath, ['resources', 'validate', '.'], { cwd: tempDir, env: { TMPDIR: root, TEMP: root, TMP: root, [VAT_CACHE_DIR_ENV]: ciCache } });
    expect(readdirSync(ciCache), validate.stderr).toContain('CACHEDIR.TAG');
    writeFileTree(ciCache, { '0.0.1-old/parse/ab/facts.json': '{"old":1}' });

    const dry = await cacheUnder(root, ['prune', '--dry-run'], { [VAT_CACHE_DIR_ENV]: ciCache });
    const dryReport = CACHE_PRUNE_REPORT_SCHEMA.parse(yaml.parse(dry.stdout));
    expect(dry.status, dry.stderr).toBe(ExitCode.OK);
    expect(dryReport.data).toMatchObject({ dryRun: true, removed: ['0.0.1-old'], entriesRemoved: 1, bytesRemoved: 9 });
    expect(existsSync(safePath.join(ciCache, '0.0.1-old'))).toBe(true);

    const real = await cacheUnder(root, ['prune'], { [VAT_CACHE_DIR_ENV]: ciCache });
    expect(real.status, real.stderr).toBe(ExitCode.OK);
    expect(CACHE_PRUNE_REPORT_SCHEMA.parse(yaml.parse(real.stdout)).data).toMatchObject({ dryRun: false, removed: ['0.0.1-old'] });
    expect(existsSync(safePath.join(ciCache, '0.0.1-old'))).toBe(false);
    expect(readdirSync(ciCache)).toContain('CACHEDIR.TAG');
  });

  it('refuses an untagged VAT_CACHE_DIR, USAGE_INVALID, exit 2, and deletes nothing', async () => {
    const { root } = tempRoot('untagged');
    const chosen = safePath.join(root, 'project-files');
    mkdirSyncReal(chosen, { recursive: true });
    writeFileSync(safePath.join(chosen, 'important.txt'), 'keep me');

    const result = await cacheUnder(root, ['prune'], { [VAT_CACHE_DIR_ENV]: chosen });

    expect(result.status, result.stderr).toBe(ExitCode.ERROR);
    expect(refusalOf(CACHE_PRUNE_REPORT_SCHEMA.parse(yaml.parse(result.stdout)))).toBe('USAGE_INVALID');
    expect(readdirSync(chosen)).toEqual(['important.txt']);
  });
});
