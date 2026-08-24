/**
 * A **committed symlink** in the git extent — three paths, three identities.
 *
 * `git ls-files` reports a symlink as an ordinary path (mode `120000`), and the
 * git extent's crawl route ignores `followSymlinks: false` — see *"The crawl
 * route changes the population"* in
 * `packages/resources/src/projection/contributors/git-extent.ts` — so the link's
 * own path IS a member here. What this file settles is what identity that path
 * then mints, and whether two links to one target stay distinguishable.
 *
 * **Not one shared identity.** The tempting reading — `canonicalPathFor`
 * resolves symlinks before hashing, therefore a link and its target collapse
 * onto one id — is false wherever git answers, and the ORDER of operations is
 * the whole mechanism: `canonicalPathFor`
 * (`packages/resources/src/projection/identity.ts`) asks
 * `GitTracker.indexPathFor` FIRST and returns from it, so its `realPathOrSelf`
 * fallback on the following line is never reached for a path git listed. That
 * map is filled from `gitLsFiles({ includeUntracked: true })` — i.e.
 * `git ls-files --cached --others --exclude-standard`, see `initialize` in
 * `packages/utils/src/git-tracker.ts` and `gitLsFiles` in
 * `packages/utils/src/git-utils.ts` — so it covers untracked-but-unignored paths
 * too, and link and target hash two different spellings whether the link is
 * committed or merely present. `distinctResourceIds() === 3` below is that pin.
 * The collapse is real only on the non-git branch, where `realPathOrSelf` does
 * run: outside a repo, under an ignored path, or with no usable tracker.
 *
 * So this is **not** a population the projection loses — the git extent
 * enumerates all three paths and keeps all three identities apart. The
 * divergence worth knowing about is BETWEEN extents, not inside this one: the
 * filesystem extent reports zero realizations for a link's own path, because
 * neither of its enumerators ever hands it over (`FilesystemCrawlSource` walks
 * with `followSymlinks: false`; `GitCrawlSource` drops the mode-`120000` entry —
 * *"A SYMLINK IS NOT A MEMBER HERE"* in
 * `packages/resources/src/projection/crawl-source.ts`). The last test here pins
 * one direction of that as a control;
 * `packages/resources/test/projection-filesystem-extent-symlink.test.ts` pins it
 * per-enumerator with a positive control.
 *
 * Two docstrings carry this same measurement and must stay consistent with this
 * file: *"🪤 A symlink and its target do NOT reliably share one identity"* in
 * `packages/resources/src/projection/identity.ts` (identity), and *"Identity
 * collapse"* in
 * `packages/resources/src/projection/contributors/agentic-convention.ts` (what
 * it means for the tag tables downstream).
 *
 * ⚠️ **Open, and deliberately not settled here:** whether `canonicalPathFor`
 * *should* realpath a symlink instead of taking git's spelling. Answering it
 * changes the population, so it awaits a ruling rather than a comment.
 *
 * Why two links, not one: a single link cannot tell "collapsed onto the target"
 * apart from "collapsed onto each other". The blob behind a symlink is its
 * **target string**, so `link-a`/`link-b` pointing at the same target are
 * byte-identical and collide on a content key as well as on an identity — a
 * fixture with one link cannot distinguish those two causes.
 *
 * The controls come FIRST in declaration order so a vacuous pass is impossible:
 * if `createSymlink` silently produced regular files, or the commit staged
 * nothing, the mode-`120000` and shared-blob-OID assertions fail before any
 * projection assertion runs. The per-test comments below state the falsifiable
 * alternative conditionally ("if `canonicalPathFor` resolves the links…") — that
 * is the hypothesis each assertion rules out, not a claim about behaviour.
 */

import { symlinkCapability } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ExtentContribution } from '../src/projection/contributor.js';
import { FilesystemExtentContributor } from '../src/projection/contributors/filesystem-extent.js';
import { GitExtentContributor } from '../src/projection/contributors/git-extent.js';

import {
  plantCommittedSymlinkFixture,
  removeCommittedSymlinkFixture,
  symlinkIndexLines,
} from './helpers/committed-symlink-fixture.js';
import { buildExtentContribution } from './test-helpers.js';

/** Committed regular file — the symlinks' target. */
const TARGET = 'docs/target.md';
/** Committed symlink → `target.md`. */
const LINK_A = 'docs/link-a.md';
/** Committed symlink → `target.md`, byte-identical to {@link LINK_A}. */
const LINK_B = 'docs/link-b.md';

let root: string;
let contribution: ExtentContribution;
let lsFilesStaged: string;

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
    // Both links point at the SAME target, so their blobs — which hold the
    // target string — are byte-identical. The shared-OID control below is what
    // proves that actually happened.
    ({ root, lsFilesStaged } = plantCommittedSymlinkFixture({
      prefix: 'vat-git-symlink-',
      files: [TARGET],
      links: [
        { path: LINK_A, target: 'target.md' },
        { path: LINK_B, target: 'target.md' },
      ],
    }));

    ({ contribution } = await buildExtentContribution(root, new GitExtentContributor()));
  });

  afterAll(() => {
    removeCommittedSymlinkFixture(root);
  });

  // ── Controls: without these the assertions below can pass vacuously ──────────

  it('committed both links as mode-120000 entries, so git really does report them', () => {
    expect(symlinkIndexLines(lsFilesStaged)).toHaveLength(2);
    expect(lsFilesStaged).toContain(TARGET);
  });

  it('stored each link\'s blob as its target STRING, which is why the two collide', () => {
    // Same target string ⇒ same blob OID for both links. This is the mechanism
    // that makes a content key unable to tell them apart.
    const oids = symlinkIndexLines(lsFilesStaged).map((line) => line.split(/\s+/)[1]);

    expect(oids).toHaveLength(2);
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
