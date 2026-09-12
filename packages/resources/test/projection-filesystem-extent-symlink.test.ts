/**
 * **The filesystem extent realizes ZERO rows for a symlink's own path** — pinned
 * against BOTH crawl sources, on one tree, in one run.
 *
 * `projection-git-extent-symlink.test.ts` pins the git extent's half of this
 * (`distinctResourceIds() === 3`: a link and its target mint DIFFERENT
 * identities, because `canonicalPathFor` returns git's index path rather than a
 * realpath). Its filesystem assertion exists only as a control for that claim,
 * and it exercises whichever enumerator `crawlSourceFor` happens to select. The
 * fact this file pins is the filesystem extent's own, and it has **two
 * independent producers** that must both keep answering the same way:
 *
 * - `FilesystemCrawlSource` walks with `followSymlinks: false`, whose
 *   `processSymlink` returns before recording anything.
 * - `GitCrawlSource` is handed the link by `git ls-files` like any other entry
 *   and drops it at its one membership seam (`crawl-source.ts`, *"A SYMLINK IS
 *   NOT A MEMBER"*).
 *
 * Either one silently changing its mind is a population change nothing else
 * catches, and `declinedPathFilter`'s `knownToExist: true` in
 * `filesystem-extent.ts` is sound only while both hold. So the source is
 * **injected** by {@link setupSymlinkExtentSuite} rather than selected from the
 * environment — a test that ran whichever arm the host defaulted to would leave
 * the other arm unpinned and read as if it had covered both.
 *
 * ⚠️ The link here is **committed**, so the git arm exercises only the half that
 * reads git's mode bits. `projection-untracked-symlink-extent.test.ts` covers the
 * other half — the prune list, where this same claim was false until the drop
 * became one seam.
 *
 * 🪤 An absence assertion is worthless on its own: an enumerator that returned
 * nothing at all would satisfy every "not realized" expectation in this file.
 * {@link PLAIN} is a regular file planted in the same directory as the link and
 * is asserted FIRST in every body below, so a broken route reddens on the
 * control before it can be mistaken for a confirmed absence.
 */

/* eslint-disable security/detect-non-literal-fs-filename -- controlled temp fixture tree */
import { lstatSync } from 'node:fs';

import { safePath, symlinkCapability } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { GIT_ARM, setupSymlinkExtentSuite, SYMLINK_ARMS, WALK_ARM } from './helpers/symlink-extent-arms.js';
import { symlinkIndexLines } from './helpers/symlink-fixture.js';

/** Committed regular file — the symlink's target. */
const TARGET = 'docs/target.md';
/** Committed symlink → `target.md`. The path whose realizations must be zero. */
const LINK = 'docs/link.md';
/**
 * ⭐ The positive control. A regular file in the SAME directory as {@link LINK},
 * and deliberately not the link's target, so "the link is absent" cannot be
 * satisfied by an enumerator that found nothing in `docs/` at all.
 */
const PLAIN = 'docs/plain.md';

// Symlink creation needs privilege on Windows; the behaviour is POSIX-observable.
// Gated on the real capability rather than raw platform, so this also runs on an
// elevated/Developer-Mode Windows host instead of skipping outright.
describe.skipIf(!symlinkCapability())('filesystem extent — a committed symlink on disk', () => {
  // ⭐ PLAIN is planted alongside LINK and is NOT the link's target — it is the
  // positive control every absence assertion below leans on, so it must be a
  // member of the fixture, not of the link's identity.
  const arms = setupSymlinkExtentSuite({
    prefix: 'vat-fs-symlink-',
    files: [TARGET, PLAIN],
    links: [{ path: LINK, target: 'target.md' }],
  });

  // ── Fixture controls: without these the absences below prove nothing ────────

  it('planted a REAL symlink on disk, not a copy of the target', () => {
    // If `symlinkSync` had silently produced a regular file, every "not
    // realized" assertion below would still pass and would mean nothing.
    const { root } = arms.fixture();

    expect(lstatSync(safePath.join(root, LINK)).isSymbolicLink()).toBe(true);
    expect(lstatSync(safePath.join(root, PLAIN)).isSymbolicLink()).toBe(false);
  });

  it('committed the link as a mode-120000 entry, so the git arm really is handed it', () => {
    // The git arm's zero is a DECISION, not an absence from its input. Without
    // this the arm could be passing because git never mentioned the link.
    const symlinkLines = symlinkIndexLines(arms.fixture().lsFilesStaged);

    expect(symlinkLines).toHaveLength(1);
    expect(symlinkLines[0]).toContain(LINK);
  });

  // ── The claim under test, once per enumerator ───────────────────────────────

  it.each(SYMLINK_ARMS)(
    '%s: realizes the plain file and the target, and ZERO rows for the link path',
    (label) => {
      const paths = arms.paths(label);

      // ⭐ POSITIVE CONTROL FIRST. An enumerator that returned nothing — a
      // broken route, a wrong root, an exclusion glob that swallowed `docs/` —
      // satisfies the absence assertion below for entirely the wrong reason.
      expect(paths).toContain(PLAIN);
      expect(paths).toContain(TARGET);

      // The claim: the link's OWN path is realized zero times.
      expect(paths.filter((path) => path === LINK)).toEqual([]);
    },
  );

  it.each(SYMLINK_ARMS)('%s: mints no resource identity for the link path either', (label) => {
    const contribution = arms.contribution(label);

    // The control, stated against `resources` rather than `realizations` so this
    // is not the previous test spelled twice: the fixture's three paths yield
    // rows for two of them plus `docs/` itself, never four.
    expect(contribution.resources.length).toBeGreaterThan(0);
    expect(arms.paths(label)).toContain(PLAIN);

    const identitiesForLink = contribution.realizations
      .filter((row) => row.path === LINK)
      .map((row) => row.resourceId);

    expect(identitiesForLink).toEqual([]);
  });

  it('both enumerators answer identically, so neither drifts alone', () => {
    // Positive control first: a pair of empty arrays is trivially equal.
    expect(arms.sortedPaths(WALK_ARM)).toContain(PLAIN);
    expect(arms.sortedPaths(WALK_ARM)).toEqual(arms.sortedPaths(GIT_ARM));
  });
});
