/**
 * `replaceDirectory` copies a plugin into the cache. The copy's directories took
 * the source's modes, so a read-only source (a store, a read-only checkout, a
 * packaging step's chmod) installed a tree whose entries nothing could unlink:
 * `vat claude plugin uninstall`, Claude Code and a plain `rm -rf` all failed on it.
 */
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { CANNOT_DENY_READS } from '@vibe-agent-toolkit/utils/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { replaceDirectory } from '../../src/install/plugin-registry.js';

let base: string;
let source: string;
let nested: string;
let dest: string;

beforeEach(() => {
  base = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-replace-dir-'));
  source = safePath.join(base, 'source');
  nested = safePath.join(source, 'skills');
  mkdirSyncReal(nested, { recursive: true });
  writeFileSync(safePath.join(nested, 'SKILL.md'), '# s\n');
  chmodSync(nested, 0o555);
  chmodSync(source, 0o555);
  dest = safePath.join(base, 'cache', '1.0.0');
});
afterEach(() => {
  for (const dir of [source, nested, dest, safePath.join(dest, 'skills')]) {
    if (existsSync(dir)) chmodSync(dir, 0o755);
  }
  rmSync(base, { recursive: true, force: true });
});

describe('replaceDirectory', () => {
  it.skipIf(CANNOT_DENY_READS)('installs a read-only source as a tree its owner can remove, keeping the other mode bits', () => {
    expect(replaceDirectory(source, dest)).toEqual([]);

    expect(statSync(dest).mode & 0o777).toBe(0o755);
    expect(statSync(safePath.join(dest, 'skills')).mode & 0o777).toBe(0o755);
    expect(() => rmSync(dest, { recursive: true })).not.toThrow();
  });
});
