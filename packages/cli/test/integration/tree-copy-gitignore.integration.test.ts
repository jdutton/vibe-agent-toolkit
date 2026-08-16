/* eslint-disable security/detect-non-literal-fs-filename */
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';

import { mkdirSyncReal, runGitOrThrow, safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { treeCopyPlugin } from '../../src/commands/claude/plugin/tree-copy.js';
import { createTempDirTracker } from '../system/test-common.js';

interface FixturePaths {
  root: string;
  src: string;
  dest: string;
}

/**
 * Initialize a temp tree with a plugin source directory, dest directory, and a
 * fresh git repo (treeCopyPlugin's gitignore filter requires a real repo).
 */
function initPluginTreeFixture(createTempDir: () => string): FixturePaths {
  const root = createTempDir();
  const src = safePath.join(root, 'plugins', 'p1');
  const dest = safePath.join(root, 'out', 'p1');
  mkdirSyncReal(src, { recursive: true });
  mkdirSyncReal(dest, { recursive: true });

  runGitOrThrow(['init', '-q'], { cwd: root });
  runGitOrThrow(['config', 'user.email', 't@t'], { cwd: root });
  runGitOrThrow(['config', 'user.name', 't'], { cwd: root });

  return { root, src, dest };
}

/** Commit whatever's in the worktree so gitignore rules are effective. */
function commitAll(root: string): void {
  runGitOrThrow(['add', '-A'], { cwd: root });
  runGitOrThrow(['commit', '-q', '-m', 'init'], { cwd: root });
}

/** Write a dummy command file so the tree has *something* that must be copied. */
async function writeCommandFile(src: string): Promise<void> {
  await mkdir(safePath.join(src, 'commands'), { recursive: true });
  await writeFile(safePath.join(src, 'commands', 'ok.md'), '# ok');
}

describe('treeCopyPlugin — gitignore enforcement', () => {
  const { createTempDir, cleanupTempDirs } = createTempDirTracker('vat-tree-copy-gi-');

  it('does not copy files matching .gitignore', async () => {
    const { root, src, dest } = initPluginTreeFixture(createTempDir);

    await writeFile(
      safePath.join(root, '.gitignore'),
      'plugins/p1/node_modules/\nplugins/p1/.env\n',
    );
    await mkdir(safePath.join(src, 'node_modules'), { recursive: true });
    await writeFile(safePath.join(src, 'node_modules', 'junk.js'), '//');
    await writeFile(safePath.join(src, '.env'), 'SECRET=x');
    await writeCommandFile(src);

    commitAll(root);

    await treeCopyPlugin({ sourceDir: src, destDir: dest });

    expect(existsSync(safePath.join(dest, 'node_modules'))).toBe(false);
    expect(existsSync(safePath.join(dest, '.env'))).toBe(false);
    expect(existsSync(safePath.join(dest, 'commands', 'ok.md'))).toBe(true);

    cleanupTempDirs();
  });

  it('copies plugins/<p>/skills/ verbatim (no special handling)', async () => {
    const { root, src, dest } = initPluginTreeFixture(createTempDir);

    await mkdir(safePath.join(src, 'skills', 'foo'), { recursive: true });
    await writeFile(
      safePath.join(src, 'skills', 'foo', 'SKILL.md'),
      '---\nname: foo\ndescription: a test skill\n---\n\n# foo\n',
    );
    await writeCommandFile(src);

    commitAll(root);

    await treeCopyPlugin({ sourceDir: src, destDir: dest });

    expect(existsSync(safePath.join(dest, 'skills', 'foo', 'SKILL.md'))).toBe(true);
    expect(existsSync(safePath.join(dest, 'commands', 'ok.md'))).toBe(true);

    cleanupTempDirs();
  });
});

/**
 * The `exclude:` knob, exercised on the GIT FAST PATH — the lane that actually
 * ships, and the one the unit tests (temp dirs, no repo) never reach.
 *
 * `git ls-files` only ever yields FILE paths, so a directory-shaped pattern
 * (`scratch`, `scratch/`) matched nothing here while the non-git walker pruned
 * the directory outright: same config, opposite result, and nothing reported
 * either way.
 */
describe('treeCopyPlugin — caller exclude patterns (git fast path)', () => {
  const { createTempDir, cleanupTempDirs } = createTempDirTracker('vat-tree-copy-ex-');
  const SCRATCH_SUBTREE_GLOB = 'scratch/**';

  it.each([[SCRATCH_SUBTREE_GLOB], ['scratch'], ['scratch/']])(
    'excludes the scratch subtree for pattern %s',
    async (pattern) => {
      const { root, src, dest } = initPluginTreeFixture(createTempDir);

      await mkdir(safePath.join(src, 'scratch'), { recursive: true });
      await writeFile(safePath.join(src, 'scratch', 'notes.md'), '# scratch');
      await writeFile(safePath.join(src, 'keep.md'), '# keep');
      await writeCommandFile(src);
      commitAll(root);

      const result = await treeCopyPlugin({ sourceDir: src, destDir: dest, exclude: [pattern] });

      expect(existsSync(safePath.join(dest, 'scratch', 'notes.md'))).toBe(false);
      expect(existsSync(safePath.join(dest, 'keep.md'))).toBe(true);
      expect(result.filesCopied).toBe(2);
      // A directory-shaped pattern must register HITS on this lane too, or the
      // caller would report a working pattern as dead (the git fast path yields
      // only file paths — see expandExcludePattern).
      expect(result.unusedExcludePatterns).toEqual([]);

      cleanupTempDirs();
    },
  );

  it('reports an exclude pattern that matched nothing on the git fast path', async () => {
    const { root, src, dest } = initPluginTreeFixture(createTempDir);

    await writeCommandFile(src);
    commitAll(root);

    const result = await treeCopyPlugin({
      sourceDir: src,
      destDir: dest,
      exclude: [SCRATCH_SUBTREE_GLOB],
    });

    expect(result.unusedExcludePatterns).toEqual([SCRATCH_SUBTREE_GLOB]);

    cleanupTempDirs();
  });

  it('never copies mis-cased agent-instruction files (git fast path)', async () => {
    const { root, src, dest } = initPluginTreeFixture(createTempDir);

    await writeFile(safePath.join(src, 'Claude.md'), '# mixed case at root');
    await mkdir(safePath.join(src, 'docs'), { recursive: true });
    await writeFile(safePath.join(src, 'docs', 'agents.md'), '# lower case at depth');
    await writeFile(safePath.join(src, 'Readme.md'), '# front page, stays');
    await writeCommandFile(src);
    commitAll(root);

    await treeCopyPlugin({ sourceDir: src, destDir: dest });

    expect(existsSync(safePath.join(dest, 'Claude.md'))).toBe(false);
    expect(existsSync(safePath.join(dest, 'docs', 'agents.md'))).toBe(false);
    expect(existsSync(safePath.join(dest, 'Readme.md'))).toBe(true);

    cleanupTempDirs();
  });
});
