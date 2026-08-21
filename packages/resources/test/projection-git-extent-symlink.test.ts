/**
 * A **committed symlink** in the git extent — the population the projection loses.
 *
 * `git ls-files` reports a symlink as an ordinary path (mode `120000`), so the git
 * extent enumerates it. But `canonicalPathFor` resolves symlinks before hashing,
 * so a link and its target mint the **same** resource identity. The question this
 * file settles is what the contributor then emits for the link's own path, and
 * whether two links to one target are distinguishable at all.
 *
 * Why two links, not one: a single link cannot tell "collapsed onto the target"
 * apart from "collapsed onto each other". The blob behind a symlink is its
 * **target string**, so `link-a`/`link-b` pointing at the same target are
 * byte-identical and collide on a content key as well as on an identity — a
 * fixture with one link cannot distinguish those two causes.
 *
 * The regular file is committed FIRST and alone in its own commit so that a
 * vacuous pass is impossible: if the fixture somehow committed nothing, the
 * mode-`120000` control below fails before any projection assertion runs.
 */

/* eslint-disable security/detect-non-literal-fs-filename -- controlled temp fixture tree */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { createSymlink, mkdirSyncReal, normalizedTmpdir, runGitOrThrow, safePath, symlinkCapability, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ExtentContribution } from '../src/projection/contributor.js';
import { FilesystemExtentContributor } from '../src/projection/contributors/filesystem-extent.js';
import { GitExtentContributor } from '../src/projection/contributors/git-extent.js';

import { buildExtentContribution } from './test-helpers.js';

/** Committed regular file — the symlinks' target. */
const TARGET = 'docs/target.md';
/** Committed symlink → `target.md`. */
const LINK_A = 'docs/link-a.md';
/** Committed symlink → `target.md`, byte-identical to {@link LINK_A}. */
const LINK_B = 'docs/link-b.md';

/** Git's mode for a symlink. Its blob holds the TARGET STRING, not file bytes. */
const GIT_MODE_SYMLINK = '120000';

const COMMIT_CONFIG = [
  '-c',
  'user.name=VAT Fixture',
  '-c',
  'user.email=fixture@example.invalid',
  '-c',
  'commit.gpgsign=false',
];

let root: string;
let contribution: ExtentContribution;
let lsFilesStaged: string;

/**
 * Run git in the fixture repo, throwing on any failure.
 *
 * @param args - Arguments after the `git` executable
 */
function git(args: readonly string[]): string {
  // `runGitOrThrow` returns stdout directly — it is not a result object.
  return runGitOrThrow([...args], { cwd: root });
}

/** Root-relative paths of every realization the contributor emitted, sorted. */
function realizedPaths(): string[] {
  return contribution.realizations.map((row) => row.path).sort((a, b) => a.localeCompare(b));
}

/** How many DISTINCT resource identities the three paths minted. */
function distinctResourceIds(): number {
  return new Set(contribution.realizations.map((row) => row.resourceId)).size;
}

// Symlink creation needs privilege on Windows; the divergence is POSIX-observable.
// Gated on the real capability rather than raw platform, so this also runs on an
// elevated/Developer-Mode Windows host instead of skipping outright.
describe.skipIf(!symlinkCapability())('git extent — a committed symlink', () => {
  beforeAll(async () => {
    root = toForwardSlash(mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-git-symlink-')));

    // symlinkCapability() is memoized, and the describe.skipIf above already
    // proved it non-null before this beforeAll ever runs.
    const cap = symlinkCapability();
    if (!cap) throw new Error('unreachable: describe.skipIf already gated on symlinkCapability()');

    git(['init']);
    mkdirSyncReal(safePath.join(root, 'docs'), { recursive: true });
    writeFileSync(safePath.join(root, TARGET), '# target\n');
    createSymlink(cap, 'target.md', safePath.join(root, LINK_A));
    createSymlink(cap, 'target.md', safePath.join(root, LINK_B));
    git(['add', TARGET, LINK_A, LINK_B]);
    git([...COMMIT_CONFIG, 'commit', '-m', 'fixture']);

    lsFilesStaged = git(['ls-files', '-s']);

    ({ contribution } = await buildExtentContribution(root, new GitExtentContributor()));
  });

  afterAll(() => {
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // ── Controls: without these the assertions below can pass vacuously ──────────

  it('committed both links as mode-120000 entries, so git really does report them', () => {
    const symlinkLines = lsFilesStaged
      .split('\n')
      .filter((line) => line.startsWith(GIT_MODE_SYMLINK));

    expect(symlinkLines).toHaveLength(2);
    expect(lsFilesStaged).toContain(TARGET);
  });

  it('stored each link\'s blob as its target STRING, which is why the two collide', () => {
    // Same target string ⇒ same blob OID for both links. This is the mechanism
    // that makes a content key unable to tell them apart.
    const oids = lsFilesStaged
      .split('\n')
      .filter((line) => line.startsWith(GIT_MODE_SYMLINK))
      .map((line) => line.split(/\s+/)[1]);

    expect(oids[0]).toBe(oids[1]);
  });

  // ── The claim under test ────────────────────────────────────────────────────

  it('enumerates the target and BOTH committed links as realizations', () => {
    expect(realizedPaths()).toEqual([LINK_A, LINK_B, TARGET]);
  });

  it('gives the three paths three distinct resource identities', () => {
    // If `canonicalPathFor` resolves the links onto the target before hashing,
    // all three paths mint ONE identity and two of them lose the
    // `(extentId, path)` race — the population loss this file is looking for.
    expect(distinctResourceIds()).toBe(3);
  });

  it('emits one resource row per enumerated path', () => {
    expect(contribution.resources).toHaveLength(3);
  });

  /**
   * The control that makes every assertion above falsifiable.
   *
   * The filesystem extent crawls with `followSymlinks: false`, so it must NOT
   * report the links. Without this, a fixture whose `symlinkSync` silently
   * produced regular files — or an assertion reading the wrong field — would
   * satisfy all four assertions above and prove nothing about symlinks at all.
   * Same tree, same fixture, opposite answer.
   */
  it('is contradicted by the filesystem extent, which skips the links entirely', async () => {
    const { contribution: fsContribution } = await buildExtentContribution(
      root,
      new FilesystemExtentContributor()
    );
    const fsPaths = fsContribution.realizations.map((row) => row.path);

    expect(fsPaths).toContain(TARGET);
    expect(fsPaths).not.toContain(LINK_A);
    expect(fsPaths).not.toContain(LINK_B);
  });
});
