/**
 * A sub-root reached through a symlinked spelling of its repository is
 * validated as the directory it spells: `vat resources validate` finds the
 * same broken link under `real/` whether the run starts in the repository or in
 * a symlinked alias of it, and whether the sub-root is named relatively or by
 * the alias's absolute path, store on and off.
 */

import { spawnSync } from 'node:child_process';

import { safePath } from '@vibe-agent-toolkit/utils';
import { createSymlink, gitExecutable, symlinkCapability } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { cleanupTestTempDir, createTestTempDir, executeCli, getBinPath, writeFileTree } from './test-common.js';

/** A collection over the whole tree, and one document under `real/` with a broken link. */
const TREE = {
  'vibe-agent-toolkit.config.yaml': 'resources:\n  collections:\n    docs:\n      include:\n        - "**/*.md"\n',
  'README.md': '# Home\n',
  'real/guide.md': '# Guide\n\nSee [the missing page](missing.md).\n',
} as const;

const symlinks = symlinkCapability();

describe.runIf(symlinks !== null)('resources validate over a sub-root by a symlinked spelling (system test)', () => {
  const binPath = getBinPath(import.meta.url);
  let tempDir: string;
  let root: string;
  let alias: string;

  beforeAll(() => {
    if (symlinks === null) return;
    tempDir = createTestTempDir('vat-resources-symlinked-subroot-');
    root = safePath.join(tempDir, 'repo');
    alias = safePath.join(tempDir, 'alias');
    writeFileTree(root, TREE);
    spawnSync(gitExecutable(), ['init', '--quiet'], { cwd: root, stdio: 'pipe' });
    spawnSync(gitExecutable(), ['add', '--all'], { cwd: root, stdio: 'pipe' });
    createSymlink(symlinks, root, alias, 'dir');
  });

  afterAll(() => {
    cleanupTestTempDir(tempDir);
  });

  it.each([
    ['repo', 'real', 'on'],
    ['alias', 'real', 'on'],
    ['repo', 'alias/real', 'on'],
    ['repo', 'real', 'off'],
    ['alias', 'real', 'off'],
    ['repo', 'alias/real', 'off'],
  ] as const)('from %s, validate %s with the store %s reports the broken link', async (from, subRoot, store) => {
    const env: Record<string, string> = { VAT_CACHE_DIR: safePath.join(tempDir, `cache-${from}-${subRoot.replace('/', '-')}-${store}`) };
    if (store === 'off') env['VAT_PROJECTION_STORE'] = 'off';
    const cwd = from === 'repo' ? root : alias;
    const target = subRoot === 'alias/real' ? safePath.join(alias, 'real') : subRoot;
    const result = await executeCli(binPath, ['resources', 'validate', target], { cwd, env });
    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.status, output).toBe(1);
    expect(output).toContain('LINK_BROKEN_FILE');
  });
});
