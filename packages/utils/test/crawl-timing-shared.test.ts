/**
 * The crawl-timing seam's `shared` stratum, and the one bracket in it.
 *
 * ## What this file is defending
 *
 * `GitTracker.initialize()` spawns `git ls-files`. Both crawlers consume the
 * tracker it builds and neither owns it, so for four commits it was charged
 * nowhere at all — and because it is SYMMETRIC, no arm comparison could ever have
 * revealed the hole. A cancelling term is invisible to the comparison it cancels
 * out of; it is not invisible to "what did this command cost", and that is the
 * question the seam exists to answer.
 *
 * So the assertions below are about a row EXISTING and being charged to the right
 * stratum, not about its size. There is no meaningful bound to assert on a
 * duration, and one asserted anyway is a flake.
 *
 * ## Why `gitLsFiles` is mocked rather than a real repository driven
 *
 * `git-tracker.test.ts` next door already mocks it the same way, and what is under
 * test here is the BRACKET — where the row lands and how many times it is charged
 * — which a real `git init` would make slower and no more conclusive. The one
 * thing a mock buys that a real repo could not: {@link NO_GIT_ANSWER} makes
 * "git did not answer" a first-class case, and a failed spawn still costs the
 * command the time it took to fail.
 */

import { mkdtempSync, rmSync } from 'node:fs';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __readCrawlTimingSnapshot,
  __setCrawlTimingForTest,
  CRAWL_PASS_INSIDE,
  CRAWL_SHARED_GIT_TRACKER_ID,
  CRAWL_STRATA,
  type CrawlTimingEntry,
  withContributorStratum,
} from '../src/crawl-timing.js';
import { GitTracker } from '../src/git-tracker.js';
import * as gitUtils from '../src/git-utils.js';
import { normalizedTmpdir, safePath } from '../src/path-utils.js';

/** What `gitLsFiles` returns when git answered. Content is irrelevant here. */
const GIT_ANSWERED: readonly string[] = ['README.md', 'src/index.ts'];

/** What `gitLsFiles` returns for every way asking can fail. */
const NO_GIT_ANSWER = null;

/** Any absolute root; nothing below touches the filesystem. */
const PROJECT_ROOT = '/project';

/**
 * The rows the seam holds right now.
 *
 * @returns Every accumulated row
 */
function rows(): readonly CrawlTimingEntry[] {
  return __readCrawlTimingSnapshot().entries;
}

/**
 * The rows charged to the tracker's synthetic id, whatever stratum they landed in.
 *
 * Deliberately not filtered by stratum: the inheritance test's whole point is
 * that the SAME bracket can land in a different one, and a helper that filtered
 * by the expected stratum would report a misfiled row as a missing row.
 *
 * @returns The tracker's rows
 */
function trackerRows(): readonly CrawlTimingEntry[] {
  return rows().filter((row) => row.contributorId === CRAWL_SHARED_GIT_TRACKER_ID);
}

describe('the crawl-timing seam’s `shared` stratum', () => {
  /**
   * Where the seam would write, kept separate from {@link PROJECT_ROOT}.
   *
   * `__setCrawlTimingForTest` creates the directory the moment it turns the seam
   * on — the seam reports an unusable dump directory while there is still a run
   * to abandon, rather than at exit where the failure costs the measurement — so
   * a fake path here prints a real failure line per test and passes anyway.
   */
  let dumpDirectory = '';

  beforeAll(() => {
    dumpDirectory = mkdtempSync(safePath.join(normalizedTmpdir(), 'crawl-timing-shared-'));
  });

  afterAll(() => {
    rmSync(dumpDirectory, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.spyOn(gitUtils, 'gitLsFiles').mockReturnValue([...GIT_ANSWERED]);
    // Nothing here writes a dump — the snapshot reader is used instead, exactly
    // as `resources/test/crawl-timing.test.ts` does. The directory still has to
    // be real; see above.
    __setCrawlTimingForTest(dumpDirectory);
  });

  afterEach(() => {
    __setCrawlTimingForTest(null);
    vi.restoreAllMocks();
  });

  it('is declared LAST, so adding it reordered no existing row', () => {
    // Dump ordering is what makes two captures of one run comparable line by
    // line. Slotting `shared` next to `crawl` — where it reads more naturally —
    // would have moved every `crawl` row down one, and a reordering is
    // indistinguishable from a measurement change to anything diffing the text.
    expect([...CRAWL_STRATA]).toEqual(['base', 'closure', 'crawl', 'shared']);
  });

  it('charges one `GitTracker.initialize()` to `shared`, at the inside-the-work pass', async () => {
    const tracker = new GitTracker(PROJECT_ROOT);
    await tracker.initialize();

    expect(trackerRows()).toEqual([
      {
        contributorId: CRAWL_SHARED_GIT_TRACKER_ID,
        stratum: 'shared',
        pass: CRAWL_PASS_INSIDE,
        calls: 1,
        elapsedMs: expect.any(Number) as unknown as number,
      },
    ]);
  });

  it('counts real initializations and not calls to the method', async () => {
    const tracker = new GitTracker(PROJECT_ROOT);
    await tracker.initialize();
    await tracker.initialize();
    await tracker.initialize();

    // `initialize` returns immediately once it has run. The early return is
    // OUTSIDE the bracket on purpose: a `calls` column that counted re-entry
    // could not be divided into a per-spawn cost, which is the only thing a
    // reader wants from it.
    expect(trackerRows().map((row) => row.calls)).toEqual([1]);
    expect(gitUtils.gitLsFiles).toHaveBeenCalledTimes(1);
  });

  it('charges the row even when git did not answer', async () => {
    vi.spyOn(gitUtils, 'gitLsFiles').mockReturnValue(NO_GIT_ANSWER);

    const tracker = new GitTracker(PROJECT_ROOT);
    await tracker.initialize();

    // A failed `git ls-files` still spawned a process and still cost the command
    // the time it took to fail. Charging only the success path would report a
    // repository-less tree — the case where the spawn is pure waste — as free.
    //
    // The stratum is asserted here as well as the count, and that is not
    // redundant with the success case above: the failure path is the one that
    // returns early from most of `initialize`, so "the row exists" and "the row
    // is filed where the success path files it" are two claims, and a check on
    // the count alone passes while the row lands on an arm.
    expect(trackerRows().map((row) => `${row.stratum}:${String(row.calls)}`)).toEqual(['shared:1']);
    expect(tracker.isUsable()).toBe(false);
  });

  it('is a FALLBACK: a tracker built inside a contributor is charged to that contributor’s arm', async () => {
    await withContributorStratum('closure', async () => {
      const tracker = new GitTracker(PROJECT_ROOT);
      await tracker.initialize();
    });

    // Nothing shipped builds a tracker from inside a contributor — the base
    // contributors are handed one. But "nothing does yet" is not an accounting
    // rule: if one ever did, it would be paying for that tracker out of its own
    // time, and `shared` would be hiding a cost one arm really incurred.
    expect(trackerRows().map((row) => row.stratum)).toEqual(['closure']);
    expect(rows().some((row) => row.stratum === 'shared')).toBe(false);
  });

  it('charges nothing at all when the seam is off', async () => {
    __setCrawlTimingForTest(null);

    const tracker = new GitTracker(PROJECT_ROOT);
    await tracker.initialize();

    // The shipped default is "no instrumentation ran", and this keeps that
    // literally true rather than approximately so.
    expect(rows()).toEqual([]);
    expect(tracker.isUsable()).toBe(true);
  });
});
