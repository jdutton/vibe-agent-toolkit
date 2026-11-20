/**
 * An untracked file git cannot read, outside every collection, does not fail
 * `vat resources validate` or `vat resources scan`, store on or off.
 *
 * With the store off the root is listed by `git ls-files`, which names the file
 * without reading it. With the store on the stored population's snapshot meets
 * the file and names it in a notice without refusing the run. Before, both
 * staged the tree into an index (`git add --all`), which read the file and
 * failed the run with exit 2.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, writeFileSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { gitExecutable } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { cleanupTestTempDir, createTestTempDir, executeCli, getBinPath, writeFileTree } from './test-common.js';

/** A clean collection, tracked; nothing in it fails validation. */
const TREE = {
  'vibe-agent-toolkit.config.yaml': 'resources:\n  collections:\n    docs:\n      include:\n        - docs/**/*.md\n',
  'docs/guide.md': '# Guide\n',
} as const;

/** chmod cannot lock a file on Windows, nor against root. */
const canLockFiles = process.platform !== 'win32' && process.getuid?.() !== 0;

describe.runIf(canLockFiles)('resources verbs over an unreadable untracked file (system test)', () => {
  const binPath = getBinPath(import.meta.url);
  let tempDir: string;
  let root: string;
  let locked: string;

  beforeAll(() => {
    tempDir = createTestTempDir('vat-resources-unreadable-');
    root = safePath.join(tempDir, 'repo');
    writeFileTree(root, TREE);
    spawnSync(gitExecutable(), ['init', '--quiet'], { cwd: root, stdio: 'pipe' });
    spawnSync(gitExecutable(), ['add', '--all'], { cwd: root, stdio: 'pipe' });
    // Untracked and not markdown: no collection names it, and git cannot read it.
    locked = safePath.join(root, 'notes.txt');
    writeFileSync(locked, 'secret\n');
    chmodSync(locked, 0o000);
  });

  afterAll(() => {
    chmodSync(locked, 0o644);
    cleanupTestTempDir(tempDir);
  });

  it.each([
    ['resources validate', 'on'],
    ['resources validate', 'off'],
    ['resources scan', 'on'],
    ['resources scan', 'off'],
  ] as const)('%s with the store %s exits 0', async (verb, store) => {
    const env: Record<string, string> = { VAT_CACHE_DIR: safePath.join(tempDir, `cache-${store}`) };
    if (store === 'off') env['VAT_PROJECTION_STORE'] = 'off';
    const result = await executeCli(binPath, [...verb.split(' '), root], { cwd: root, env });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });
});
