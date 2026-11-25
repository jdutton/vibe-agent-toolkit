/**
 * An edit arm against a real git tree: what is refused before priming, that the
 * tree is restored when the apply itself fails part-way, that every git it runs
 * is the arm's (a developer's global config changes nothing), and that it edits
 * only the lab's own prepared clone.
 *
 * Integration-tier: real git; the sequence cases spawn the stand-in probe.
 */

import { readFileSync, rmSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { applyEdits, editCandidates, type EditAction, refuseUnplannableEdit, restoreEdits } from '../../src/harness/edit-step.js';
import { runRepeats } from '../../src/harness/repeat.js';
import { fixtureArmGit, preparedCloneDirectory, stubDeveloperGitConfig } from '../arm-tree-fixtures.js';
import { cleanupProbes, probeSpec, setupProbe } from '../command-probe.js';
import { commitAll, git as fixtureGit, initRepo, writeFixtureFile } from '../git-fixtures.js';

import { cleanupVerdictFixtures, tempDir } from './verdict-fixtures.js';

afterAll(cleanupProbes);
afterAll(cleanupVerdictFixtures);
afterEach(() => {
  vi.unstubAllEnvs();
});

/** The committed bytes of the one page every case edits. */
const PAGE = '# a\n';

/** The refusal every edit-arm refusal carries. */
const REFUSED = 'LAB_ARM_REFUSED';

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

/** @returns A committed tree, and the arm git every case runs on it */
function armTree(prefix: string): { readonly root: string; readonly git: ReturnType<typeof fixtureArmGit> } {
  return { root: committedTree(tempDir(prefix)), git: fixtureArmGit(tempDir(`${prefix}arm-`)) };
}

describe('refuseUnplannableEdit', () => {
  it('refuses a delete arm whose rounds need more files than there are, naming both numbers', () => {
    const { root, git } = armTree('lab-edit-refuse-');

    expect(() => refuseUnplannableEdit(git, root, { kind: 'delete', count: 1, paths: null }, 3)).not.toThrow();
    expect(() => refuseUnplannableEdit(git, root, { kind: 'delete', count: 2, paths: null }, 2)).toThrow(
      /warm-edit2:delete over 2 rounds deletes 4 distinct files, but there are only 3 tracked markdown files/u,
    );
    // modify and create mark the round in their bytes, so their rounds need no more files.
    expect(() => refuseUnplannableEdit(git, root, { kind: 'modify', count: 3, paths: null }, 5)).not.toThrow();
  });

  it('refuses an --edit path that is not a tracked file, with a code', () => {
    const { root, git } = armTree('lab-edit-refuse-');
    writeFixtureFile(root, 'untracked.md', '# u\n');

    expect(() => refuseUnplannableEdit(git, root, { kind: 'modify', count: 1, paths: ['untracked.md'] }, 5)).toThrow(
      expect.objectContaining({ code: REFUSED, message: expect.stringMatching(/--edit 'untracked\.md' is not a tracked file/u) }),
    );
    expect(() => refuseUnplannableEdit(git, root, { kind: 'modify', count: 1, paths: ['missing.md'] }, 5)).toThrow(/not a tracked file/u);
    expect(() => refuseUnplannableEdit(git, root, { kind: 'modify', count: 1, paths: ['b.md'] }, 5)).not.toThrow();
  });
});

describe('editCandidates', () => {
  it('treats frontmatter after a byte-order mark as frontmatter', () => {
    const { root, git } = armTree('lab-edit-bom-');
    const bom = String.fromCodePoint(0xfe_ff);
    writeFixtureFile(root, 'bom.md', `${bom}---\ntitle: b\n---\n`);
    writeFixtureFile(root, 'bom-plain.md', `${bom}# plain\n`);
    commitAll(root, 'bom pages');

    expect(editCandidates(git, root).sort((x, y) => x.localeCompare(y))).toEqual(['a.md', 'b.md', 'bom-plain.md', 'c.md']);
  });

  it('refuses, with the arm refusal code, a tracked page missing from the work tree', () => {
    const { root, git } = armTree('lab-edit-missing-');
    // Gone from disk only: the index still tracks it, so git lists it and a raw ENOENT would escape with no code.
    rmSync(safePath.join(root, 'b.md'));
    expect(git(['ls-files', 'b.md'], root).stdout).toBe('b.md'); // positive control: still tracked

    expect(() => editCandidates(git, root)).toThrow(
      expect.objectContaining({ code: REFUSED, message: expect.stringMatching(/edits 'b\.md', which is not in the work tree/u) }),
    );
  });
});

describe('restoring a part-way apply', () => {
  it('records only what the apply reached, refuses the missing file with a code, and restores', () => {
    const { root, git } = armTree('lab-edit-partial-');
    const actions: EditAction[] = [
      { kind: 'modify', path: 'a.md', append: 'x' },
      { kind: 'modify', path: 'missing.md', append: 'x' },
    ];
    const reached: EditAction[] = [];

    expect(() => applyEdits(git, root, actions, reached)).toThrow(
      expect.objectContaining({ code: REFUSED, message: expect.stringMatching(/edits 'missing\.md', which is not in the work tree/u) }),
    );
    expect(reached.map((action) => action.path)).toEqual(['a.md']);
    expect(restoreEdits(git, root, reached)).toBeNull();
    expect(readFileSync(safePath.join(root, 'a.md'), 'utf-8')).toBe(PAGE);
  });

  it('restores the tree when an edit arm fails in its apply, before any step', async () => {
    const probe = setupProbe('lab-edit-apply-');
    const clone = committedTree(preparedCloneDirectory(probe.armsRoot));
    const spec = probeSpec(probe, { editPaths: ['a.md', 'missing.md'], runs: 1 });

    await expect(
      runRepeats({ ...spec, cwd: clone, arm: { ...spec.arm, state: { warm: 'edit', count: 2, kind: 'modify' } } }),
    ).rejects.toThrow(expect.objectContaining({ code: REFUSED, message: expect.stringMatching(/not in the work tree/u) }));
    expect(readFileSync(safePath.join(clone, 'a.md'), 'utf-8')).toBe(PAGE);
  });
});

describe("every git an edit runs is the arm's, never the developer's config", () => {
  it('counts a created file a global core.excludesFile would hide', () => {
    const { root, git } = armTree('lab-edit-excludes-');
    const home = tempDir('lab-edit-excludes-home-');
    const excludes = safePath.join(home, 'excludes');
    writeFileSync(excludes, 'lab-edit-*\n');
    stubDeveloperGitConfig(home, `[core]\n\texcludesFile = ${excludes}\n`);
    const reached: EditAction[] = [];

    const applied = applyEdits(git, root, [{ kind: 'create', path: 'lab-edit-0-0.md', content: '# new\n' }], reached);

    expect(applied.changed).toBe(1);
    expect(restoreEdits(git, root, reached)).toBeNull();
  });

  it("restores a file's committed line endings under a global core.autocrlf=true", () => {
    const { root, git } = armTree('lab-edit-autocrlf-');
    stubDeveloperGitConfig(tempDir('lab-edit-autocrlf-home-'), '[core]\n\tautocrlf = true\n');
    const reached: EditAction[] = [];

    applyEdits(git, root, [{ kind: 'modify', path: 'a.md', append: '\n<!-- edit -->\n' }], reached);

    expect(restoreEdits(git, root, reached)).toBeNull();
    expect(readFileSync(safePath.join(root, 'a.md'), 'utf-8')).toBe(PAGE);
  });
});

describe('an edit arm edits only the lab-prepared clone', () => {
  it("refuses, with a code, an edit arm whose tree is not the arms root's prepared clone, touching nothing", async () => {
    const probe = setupProbe('lab-edit-owner-');
    committedTree(probe.cwd);
    preparedCloneDirectory(probe.armsRoot); // a marked root with a clone: the subject is still not it
    const spec = probeSpec(probe, { editPaths: ['a.md'], runs: 1 });

    await expect(runRepeats({ ...spec, arm: { ...spec.arm, state: { warm: 'edit', count: 1, kind: 'modify' } } })).rejects.toThrow(
      expect.objectContaining({ code: REFUSED, message: expect.stringMatching(/edits the tree it runs in: .* is not the lab's prepared clone/u) }),
    );
    expect(readFileSync(safePath.join(probe.cwd, 'a.md'), 'utf-8')).toBe(PAGE);
  });

  it('refuses a clone-named tree under an arms root the lab never marked', async () => {
    const probe = setupProbe('lab-edit-unmarked-');
    const clone = committedTree(mkdirSyncReal(safePath.join(probe.armsRoot, 'clone'), { recursive: true }));
    const spec = probeSpec(probe, { editPaths: ['a.md'], runs: 1 });

    await expect(
      runRepeats({ ...spec, cwd: clone, arm: { ...spec.arm, state: { warm: 'edit', count: 1, kind: 'modify' } } }),
    ).rejects.toThrow(expect.objectContaining({ code: REFUSED, message: expect.stringMatching(/carries no \.vat-lab-root/u) }));
  });
});

/**
 * @param assumeUnchanged - Whether git is told to ignore the edited page's changes
 * @returns The one measured repetition of a warm-edit1 arm editing `a.md` in a prepared clone
 */
async function editOnce(assumeUnchanged: boolean): Promise<{ readonly clone: string; readonly violation: string | null; readonly changed: number | undefined }> {
  const probe = setupProbe('lab-edit-missed-');
  const clone = preparedCloneDirectory(probe.armsRoot);
  // The probe logs into its working directory; ignored, so the log is no change git counts.
  writeFixtureFile(clone, '.gitignore', 'probe.log\n');
  committedTree(clone);
  if (assumeUnchanged) fixtureGit(['update-index', '--assume-unchanged', 'a.md'], clone);
  const spec = probeSpec(probe, { editPaths: ['a.md'], runs: 1 });
  const run = await runRepeats({ ...spec, cwd: clone, arm: { ...spec.arm, state: { warm: 'edit', count: 1, kind: 'modify' } } });
  const [result] = run.results;
  return { clone, violation: result?.violation ?? null, changed: result?.edits?.changed };
}

describe('an edit that did not land', () => {
  it('passes a repetition whose edit git saw', async () => {
    const landed = await editOnce(false);

    expect(landed).toMatchObject({ violation: null, changed: 1 });
  });

  it('fails a repetition whose edit git cannot see (the page marked assume-unchanged), and restores it', async () => {
    const missed = await editOnce(true);

    expect(missed.changed).toBe(0);
    expect(missed.violation).toBe("edit rule: editing 1 file(s) left 0 changed path(s) in git's view");
    expect(readFileSync(safePath.join(missed.clone, 'a.md'), 'utf-8')).toBe(PAGE);
  });
});
