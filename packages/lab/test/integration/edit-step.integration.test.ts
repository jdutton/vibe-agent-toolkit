/**
 * An edit arm against a real git tree: what is refused before priming, and
 * that the tree is restored when the apply itself fails part-way.
 *
 * Integration-tier: real git; the sequence case spawns the stand-in probe.
 */

import { readFileSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, describe, expect, it } from 'vitest';

import { applyEdits, type EditAction, refuseUnplannableEdit, restoreEdits } from '../../src/harness/edit-step.js';
import { runRepeats } from '../../src/harness/repeat.js';
import { cleanupProbes, probeSpec, setupProbe } from '../command-probe.js';
import { commitAll, initRepo, writeFixtureFile } from '../git-fixtures.js';

import { cleanupVerdictFixtures, tempDir } from './verdict-fixtures.js';

afterAll(cleanupProbes);
afterAll(cleanupVerdictFixtures);

/** The committed bytes of the one page every case edits. */
const PAGE = '# a\n';

/**
 * @param root - An empty directory
 * @returns It, as a committed tree of three frontmatter-free pages and one with frontmatter
 */
function committedTree(root: string): string {
  initRepo(root);
  writeFixtureFile(root, 'a.md', PAGE);
  writeFixtureFile(root, 'b.md', '# b\n');
  writeFixtureFile(root, 'c.md', '# c\n');
  writeFixtureFile(root, 'schema.md', '---\ntitle: s\n---\n');
  commitAll(root, 'tree');
  return root;
}

describe('refuseUnplannableEdit', () => {
  it('refuses a delete arm whose rounds need more files than there are, naming both numbers', () => {
    const root = committedTree(tempDir('lab-edit-refuse-'));

    expect(() => refuseUnplannableEdit(root, { kind: 'delete', count: 1, paths: null }, 3)).not.toThrow();
    expect(() => refuseUnplannableEdit(root, { kind: 'delete', count: 2, paths: null }, 2)).toThrow(
      /warm-edit2:delete over 2 rounds deletes 4 distinct files, but there are only 3 tracked markdown files/u,
    );
    // modify and create mark the round in their bytes, so their rounds need no more files.
    expect(() => refuseUnplannableEdit(root, { kind: 'modify', count: 3, paths: null }, 5)).not.toThrow();
  });

  it('refuses an --edit path that is not a tracked file, with a code', () => {
    const root = committedTree(tempDir('lab-edit-refuse-'));
    writeFixtureFile(root, 'untracked.md', '# u\n');

    expect(() => refuseUnplannableEdit(root, { kind: 'modify', count: 1, paths: ['untracked.md'] }, 5)).toThrow(
      expect.objectContaining({ code: 'LAB_ARM_REFUSED', message: expect.stringMatching(/--edit 'untracked\.md' is not a tracked file/u) }),
    );
    expect(() => refuseUnplannableEdit(root, { kind: 'modify', count: 1, paths: ['missing.md'] }, 5)).toThrow(/not a tracked file/u);
    expect(() => refuseUnplannableEdit(root, { kind: 'modify', count: 1, paths: ['b.md'] }, 5)).not.toThrow();
  });
});

describe('restoring a part-way apply', () => {
  it('records only what the apply reached, so the restore undoes it', () => {
    const root = committedTree(tempDir('lab-edit-partial-'));
    const actions: EditAction[] = [
      { kind: 'modify', path: 'a.md', append: 'x' },
      { kind: 'modify', path: 'missing.md', append: 'x' },
    ];
    const reached: EditAction[] = [];

    expect(() => applyEdits(root, actions, reached)).toThrow(/ENOENT/u);
    expect(reached.map((action) => action.path)).toEqual(['a.md']);
    expect(restoreEdits(root, reached)).toBeNull();
    expect(readFileSync(safePath.join(root, 'a.md'), 'utf-8')).toBe(PAGE);
  });

  it('restores the tree when an edit arm fails in its apply, before any step', async () => {
    const probe = setupProbe('lab-edit-apply-');
    committedTree(probe.cwd);
    const spec = probeSpec(probe, { editPaths: ['a.md', 'missing.md'], runs: 1 });

    await expect(runRepeats({ ...spec, arm: { ...spec.arm, state: { warm: 'edit', count: 2, kind: 'modify' } } })).rejects.toThrow(/ENOENT/u);
    expect(readFileSync(safePath.join(probe.cwd, 'a.md'), 'utf-8')).toBe(PAGE);
  });
});
