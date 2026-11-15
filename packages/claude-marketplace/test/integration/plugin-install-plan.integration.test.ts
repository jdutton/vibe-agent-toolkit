/**
 * A plugin install (`planPackageInstall`) as a plan on a real filesystem: the copy into the cache is staged
 * beside it and swapped in whole, so a copy that fails costs nothing, and a read-only
 * source (a store, a read-only checkout, a packaging step's chmod) becomes a tree its
 * owner can remove — `vat claude plugin uninstall`, Claude Code and a plain `rm -rf`
 * all failed on the copy that took the source's modes.
 */
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';

import { FS_FAULT_CODE, mkdirSyncReal, normalizedTmpdir, relativeEscapesRoot, safePath } from '@vibe-agent-toolkit/utils';
import { CANNOT_DENY_READS, diffSnapshots, type FaultFsSession, installFaultFs, snapshotTree } from '@vibe-agent-toolkit/utils/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ClaudeUserPaths } from '../../src/paths/claude-paths.js';
import { buildTestPaths, installOnePlugin, useScratchTmpdir } from '../test-helpers.js';

let base: string;
let source: string;
let nested: string;
let paths: ClaudeUserPaths;
let session: FaultFsSession | undefined;

beforeEach(() => {
  base = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-install-plan-'));
  source = safePath.join(base, 'source');
  nested = safePath.join(source, 'skills');
  mkdirSyncReal(nested, { recursive: true });
  writeFileSync(safePath.join(nested, 'SKILL.md'), '# s\n');
  paths = buildTestPaths(base);
});
afterEach(() => {
  session?.restore();
  session = undefined;
  for (const dir of [source, nested]) {
    if (existsSync(dir)) chmodSync(dir, 0o755);
  }
  rmSync(base, { recursive: true, force: true });
});
useScratchTmpdir('vat-install-plan-tmp-');

const install = (): Promise<unknown> => installOnePlugin(source, paths, {
  marketplaceName: 'mp',
  pluginName: 'p',
  version: '1.0.0',
  source: { source: 'npm', package: '@test/p', version: '1.0.0' },
});

const cacheVersion = (): string => safePath.join(paths.pluginsCacheDir, 'mp', 'p', '1.0.0');

describe('installing one plugin', () => {
  it.skipIf(CANNOT_DENY_READS)('installs a read-only source as a tree its owner can remove, keeping the other mode bits', async () => {
    chmodSync(nested, 0o555);
    chmodSync(source, 0o555);

    await expect(install()).resolves.toEqual({ warnings: [] });

    expect(statSync(cacheVersion()).mode & 0o777).toBe(0o755);
    expect(statSync(safePath.join(cacheVersion(), 'skills')).mode & 0o777).toBe(0o755);
    expect(() => rmSync(cacheVersion(), { recursive: true })).not.toThrow();
  });

  // The disk fills half-way through the cache copy: the previous install, which the registry
  // still names, must be exactly what it was, with no staged copy left beside it.
  it('keeps the previous install whole, and leaves no staged copy, when the disk fills mid-copy', async () => {
    await install();
    writeFileSync(safePath.join(nested, 'SKILL.md'), '# s, second\n');
    writeFileSync(safePath.join(source, 'more.md'), 'more\n');
    const before = snapshotTree(paths.claudeDir);
    const versions = safePath.join(paths.pluginsCacheDir, 'mp', 'p');
    const underVersions = (p: string): boolean => !relativeEscapesRoot(safePath.relative(versions, p));
    session = installFaultFs({ within: base, faults: [{ family: 'write', op: 'writeFile', path: underVersions, nth: 2, errno: 'ENOSPC' }] });

    await expect(install()).rejects.toMatchObject({ code: FS_FAULT_CODE, side: 'destination', faultClass: 'exhausted' });
    session.restore();

    expect(diffSnapshots(before, snapshotTree(paths.claudeDir))).toEqual([]);
    expect(readdirSync(versions)).toEqual(['1.0.0']);
    expect(readFileSync(safePath.join(cacheVersion(), 'skills', 'SKILL.md'), 'utf-8')).toBe('# s\n');
  });
});
