/**
 * `vat cache clear` publishes the report envelope — observed through the built CLI.
 *
 * ⛔ Never against the real cache. The command deletes `<tmpdir>/.vat-cache`,
 * and that tree is shared with every other VAT on the machine — this suite's
 * own sibling test files included. Every run here redirects the child's temp
 * root (`TMPDIR` on POSIX, `TEMP` / `TMP` on Windows) into a directory the
 * test owns, so the tree it clears is one it built.
 */

import { chmodSync } from 'node:fs';

import { ExitCode } from '@vibe-agent-toolkit/schema';
import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { CANNOT_DENY_READS } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import yaml from 'yaml';

import { CACHE_CLEAR_REPORT_SCHEMA, type CacheClearReport } from '../../src/commands/cache/clear-schema.js';

import { cleanupTestTempDir, createTestTempDir, executeCli, getBinPath, writeFileTree } from './test-common.js';

const binPath = getBinPath(import.meta.url);

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
 * Run `vat cache clear` with its temp root redirected to `root`, and read its
 * document with the published schema.
 */
async function clearUnder(root: string): Promise<{ status: number | null; stderr: string; report: CacheClearReport }> {
  const result = await executeCli(binPath, ['cache', 'clear'], { cwd: tempDir, env: { TMPDIR: root, TEMP: root, TMP: root } });
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
    expect(report.data).toMatchObject({ existed: true, removed: ['external-links.json', 'ns'], remaining: [], entriesRemoved: 2, bytesRemoved: 9 });
  });

  it('a cache that is not there is ok, exit 0, with existed: false', async () => {
    const { root } = tempRoot('absent');

    const { status, stderr, report } = await clearUnder(root);

    expect(status, stderr).toBe(ExitCode.OK);
    expect(report).toMatchObject({ status: 'ok', examined: 1, data: { existed: false, removed: [], remaining: [] } });
  });

  it.skipIf(CANNOT_DENY_READS)('cache clear partial publishes error RUN_INCOMPLETE with the removed entries in data, exit 2', async () => {
    // A directory whose entries cannot be unlinked: the delete removes its
    // siblings and stops at it — the partial clear a concurrent writer causes.
    const { root, cacheDir } = tempRoot('partial');
    writeFileTree(cacheDir, { 'a.json': '{}', 'stuck/inner.json': '{}' });
    const stuck = safePath.join(cacheDir, 'stuck');
    chmodSync(stuck, UNWRITABLE);
    locked.push(stuck);

    const { status, stderr, report } = await clearUnder(root);

    expect(status, stderr).toBe(ExitCode.ERROR);
    expect(refusalOf(report)).toBe('RUN_INCOMPLETE');
    expect(report.examined).toBe(1);
    expect(report.data).toMatchObject({ existed: true, remaining: ['stuck'] });
    expect(report.data?.removed).not.toContain('stuck');
  });

  it.skipIf(CANNOT_DENY_READS)('a cache root the OS will not list is INPUT_UNREADABLE, exit 2, nothing removed', async () => {
    const { root, cacheDir } = tempRoot('unreadable');
    writeFileTree(cacheDir, { 'a.json': '{}' });
    chmodSync(cacheDir, UNREADABLE);
    locked.push(cacheDir);

    const { status, stderr, report } = await clearUnder(root);

    expect(status, stderr).toBe(ExitCode.ERROR);
    expect(refusalOf(report)).toBe('INPUT_UNREADABLE');
    expect(report.data).toBeNull();
  });
});
