/**
 * **An UNTRACKED symlink is not a member either** — the half of "no crawl source
 * emits a symlink's own path" that every existing fixture was structurally
 * unable to test.
 *
 * `projection-filesystem-extent-symlink.test.ts` pins the same claim, but its
 * link is **committed**, and a committed link can only ever arrive through
 * `GitCrawlSource`'s tree-snapshot half — the half that reads git's mode bits
 * and drops mode `120000`. The snapshot is not the only source that hands paths
 * over: `#untrackedTerritory` re-offers whatever `ls-files --others --directory`
 * lists, and git spells a symlink there exactly like a file. A fixture whose
 * links are all committed therefore exercises one lane and reads as if it had
 * covered the mechanism, which is precisely how the untracked lane came to emit
 * symlinks under a docstring in four files, and one published `vat claude
 * budget` limit, all saying that no lane does.
 *
 * So the two links here are planted AFTER the fixture's commit and never staged,
 * and the controls prove that rather than assuming it — the staged listing must
 * contain NO mode-`120000` line at all, or a green run would be the committed
 * drop passing under a different name.
 *
 * ## Two untracked lanes, not one
 *
 * `ls-files --others` and `ls-files --others --ignored` are separate listings
 * reached by separate calls, and only one of them is covered by the tree
 * snapshot: `git add --all` stages an untracked-but-unignored path (so the
 * snapshot sees the symlink's mode and drops it, and the prune list then hands
 * it back), while an ignored path is staged by nothing and reaches membership
 * only through the prune list. {@link UNTRACKED_LINK} and {@link IGNORED_LINK}
 * are one per lane.
 *
 * ## Why this is a wrong NUMBER and not only a wrong row
 *
 * A symlink's bytes are its target's bytes, so the link and the target realize
 * the same `contentKey` while minting two identities — `canonicalPathFor` takes
 * git's spelling for anything `git ls-files --cached --others` lists, and never
 * reaches its `realpath` fallback. Two identities over one set of bytes is a
 * budget that charges those bytes twice, which is the direction that makes a
 * reader cut context they did not need to cut. The last test states that as a
 * property over the whole contribution rather than as a fact about these two
 * paths, so a future source that mints a third such pair reddens here.
 *
 * 🪤 Every claim below is an ABSENCE, and an enumerator that returned nothing at
 * all satisfies all of them. {@link UNTRACKED_PLAIN} and {@link IGNORED_PLAIN}
 * are regular files planted in the same lane as their link and asserted FIRST,
 * so a lane that stopped being enumerated reddens on the control instead of
 * reading as a confirmed absence.
 */

/* eslint-disable security/detect-non-literal-fs-filename -- controlled temp fixture tree */
import { lstatSync } from 'node:fs';

import { safePath, symlinkCapability } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { setupSymlinkExtentSuite, SYMLINK_ARMS, WALK_ARM } from './helpers/symlink-extent-arms.js';
import { symlinkIndexLines } from './helpers/symlink-fixture.js';

/** The one committed regular file — every link below points at it. */
const TARGET = 'docs/target.md';
/** Untracked, not ignored: staged by the tree snapshot, handed back by the prune list. */
const UNTRACKED_LINK = 'docs/untracked-link.md';
/** ⭐ Positive control for the untracked lane. A regular file, not the link's target. */
const UNTRACKED_PLAIN = 'docs/untracked-plain.md';
/** Ignored: no snapshot entry exists at all, so only the prune list can offer it. */
const IGNORED_LINK = 'docs/ignored-link.md';
/** ⭐ Positive control for the ignored lane. */
const IGNORED_PLAIN = 'docs/ignored-plain.md';

/** Both untracked links, with the lane each one arrives through. */
const LINKS: readonly (readonly [string, string])[] = [
  ['untracked, not ignored', UNTRACKED_LINK],
  ['ignored', IGNORED_LINK],
];

// Symlink creation needs privilege on Windows; the behaviour is POSIX-observable.
// Gated on the real capability rather than raw platform, so this also runs on an
// elevated/Developer-Mode Windows host instead of skipping outright.
describe.skipIf(!symlinkCapability())('crawl sources — an UNTRACKED symlink on disk', () => {
  // Only the target is committed. Everything the claim is about is planted after
  // the commit, which is what makes this fixture able to fail at all.
  const arms = setupSymlinkExtentSuite({
    prefix: 'vat-untracked-symlink-',
    files: [TARGET],
    links: [],
    ignore: ['ignored-*'],
    untrackedFiles: [UNTRACKED_PLAIN, IGNORED_PLAIN],
    untrackedLinks: [
      { path: UNTRACKED_LINK, target: 'target.md' },
      { path: IGNORED_LINK, target: 'target.md' },
    ],
  });

  // ── Fixture controls: without these the absences below prove nothing ────────

  it.each(LINKS)('%s: planted a REAL symlink on disk, not a copy of the target', (_lane, link) => {
    // If `symlinkSync` had silently produced a regular file, every "not
    // realized" assertion below would still pass and would mean nothing.
    expect(lstatSync(safePath.join(arms.fixture().root, link)).isSymbolicLink()).toBe(true);
  });

  it('staged NO symlink, so a pass cannot be the committed mode-120000 drop', () => {
    // ⭐ The control that makes this file different from
    // `projection-filesystem-extent-symlink.test.ts`. If either link reached the
    // index, `#snapshotMembers` would drop it on git's mode bits and the
    // untracked lane would never be asked the question.
    const { lsFilesStaged } = arms.fixture();

    expect(symlinkIndexLines(lsFilesStaged)).toEqual([]);
    expect(lsFilesStaged).toContain(TARGET);
    expect(lsFilesStaged).not.toContain(UNTRACKED_LINK);
    expect(lsFilesStaged).not.toContain(IGNORED_LINK);
  });

  it('git lists each link in its own untracked lane, so both lanes really are handed one', () => {
    // The zeroes below are DECISIONS, not absences from the input.
    const { lsFilesOthers, lsFilesIgnored } = arms.fixture();

    expect(lsFilesOthers).toContain(UNTRACKED_LINK);
    expect(lsFilesOthers).toContain(UNTRACKED_PLAIN);
    expect(lsFilesIgnored).toContain(IGNORED_LINK);
    expect(lsFilesIgnored).toContain(IGNORED_PLAIN);
    // Distinct lanes, not one listing reported twice.
    expect(lsFilesOthers).not.toContain(IGNORED_LINK);
  });

  // ── The claim under test, once per enumerator ───────────────────────────────

  it.each(SYMLINK_ARMS)('%s: realizes both lanes, and ZERO rows for either link path', (label) => {
    const paths = arms.paths(label);

    // ⭐ POSITIVE CONTROLS FIRST, one per lane. An arm that stopped enumerating
    // untracked or ignored territory satisfies the absences below for entirely
    // the wrong reason.
    expect(paths).toContain(TARGET);
    expect(paths).toContain(UNTRACKED_PLAIN);
    expect(paths).toContain(IGNORED_PLAIN);

    expect(paths.filter((path) => path === UNTRACKED_LINK)).toEqual([]);
    expect(paths.filter((path) => path === IGNORED_LINK)).toEqual([]);
  });

  it('the two enumerators disagree about nothing, in either untracked lane', () => {
    // ⭐ Control before the difference: two arms that enumerated nothing agree
    // perfectly, so the fixture's own paths are asserted present first.
    expect(arms.paths(WALK_ARM)).toContain(IGNORED_PLAIN);

    const { onlyWalk, onlyGit } = arms.armDisagreements();

    // `onlyGit` is where this defect lived: the git arm carried both links and
    // the walk carried neither. Named separately from `onlyWalk` so a failure
    // says which arm grew a path rather than only that they differ.
    expect(onlyGit).toEqual([]);
    expect(onlyWalk).toEqual([]);
  });

  it.each(SYMLINK_ARMS)('%s: charges no set of bytes to two identities', (label) => {
    const identitiesByKey = new Map<string, Set<string>>();
    for (const row of arms.contribution(label).realizations) {
      if (row.contentKey === null) continue;
      const identities = identitiesByKey.get(row.contentKey) ?? new Set<string>();
      identities.add(row.resourceId);
      identitiesByKey.set(row.contentKey, identities);
    }

    // Control: an extent that keyed nothing has no duplicates to find.
    expect(identitiesByKey.size).toBeGreaterThan(0);

    const shared = [...identitiesByKey.entries()]
      .filter(([, identities]) => identities.size > 1)
      .map(([contentKey]) => contentKey);

    // A symlink realizes its TARGET's bytes under its OWN identity, so a link
    // that slipped into the population makes one set of bytes billable twice —
    // an over-report in `vat claude budget`, the direction that makes a reader
    // cut context they did not have to cut.
    expect(shared).toEqual([]);
  });
});
