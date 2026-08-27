/**
 * `compareCrawl`'s refusal to compare two arms measured by different instruments.
 *
 * ## The bug this file is the guard for, stated as it actually happened
 *
 * A bracket added to the seam charges work that was previously charged NOWHERE.
 * No existing row changes — so every row lines up, and every per-row delta is
 * zero — while the command TOTAL grows, because it sums additive rows across
 * every stratum. An A/B across that boundary therefore reads a widening of the
 * INSTRUMENT as a regression in the SUBJECT.
 *
 * The part that makes it dangerous rather than merely wrong is the consistency:
 * the new row is present in every arm-B capture and absent from every arm-A one,
 * so every pair says `changed` for the same reason. `ab` reads unanimous verdicts
 * as `stable` — the tool agreeing with itself — and prints a confident magnitude
 * instead of refusing. That is what the `shared` stratum did on
 * `worktree-resource-projection-stage3`, and what the projection's blob stage
 * would have done next.
 *
 * ⛔ The dump version could not catch it and never could: an integer says
 * "different", never "different how", and it moves only when a human moves it.
 * Nobody moved it for `shared`, on an argument that was right about rows and
 * wrong about totals. So the dump now declares what its build can CHARGE, and
 * the assertions below are about that declaration being consulted before any
 * subtraction happens.
 *
 * There was no `compare.ts` test for this facet at all before this file.
 */

import { describe, expect, it } from 'vitest';

import { compareCrawl } from '../src/facets/crawl/compare.js';
import { CRAWL_FACET } from '../src/facets/crawl/types.js';
import type { CrawlCommandStats, CrawlDumpCharges } from '../src/facets/crawl/types.js';

import { CLEAN_LOAD, makeReport } from './report-fixtures.js';

/** Thresholds. Large enough that no duration below is ever "significant". */
const OPTIONS = { minRelative: 0.1, minAbsoluteMs: 2, minAbsoluteCalls: 1 } as const;

/** The synthetic id for the walk, named once — it appears in both arms and a row. */
const WALKER_ID = 'walk-link-graph:walk';

/** A build that predates the `shared` stratum. */
const OLD_CHARGES: CrawlDumpCharges = {
  strata: ['base', 'closure', 'crawl'],
  syntheticIds: ['resource-registry:enumerate', WALKER_ID],
};

/** The same build after the tracker bracket landed. */
const NEW_CHARGES: CrawlDumpCharges = {
  strata: ['base', 'closure', 'crawl', 'shared'],
  syntheticIds: ['git-tracker:initialize', 'resource-registry:enumerate', WALKER_ID],
};

/**
 * One command row.
 *
 * The rows are deliberately IDENTICAL between the two arms below — same entries,
 * same strata, same call counts. Only `totalMs` and `charges` differ, which is
 * exactly the shape of the real failure: nothing a per-row diff looks at moved.
 *
 * @param charges - What that arm's build could charge
 * @param totalMs - The command total
 * @returns The row
 */
function row(charges: CrawlDumpCharges, totalMs: number): CrawlCommandStats {
  return {
    name: 'audit',
    args: ['audit'],
    cache: 'warm',
    runs: 3,
    stable: true,
    attribution: 'measured',
    charges,
    entries: [
      {
        contributorId: WALKER_ID,
        stratum: 'crawl',
        pass: 0,
        calls: 6,
        elapsedMs: 1.1,
        role: 'additive',
      },
    ],
    strata: [
      {
        stratum: 'crawl',
        calls: 6,
        elapsedMs: 1.1,
        nested: { calls: 0, elapsedMs: 0 },
        unclassified: { calls: 0, elapsedMs: 0 },
      },
    ],
    totalCalls: 6,
    totalMs,
    totalMsSamples: [totalMs],
    processes: [{ pid: 1, wallMs: 500, cpuUserMs: 400, cpuSystemMs: 50 }],
    failed: false,
    failure: null,
  };
}

/**
 * Compare two arms and return the single command's verdict.
 *
 * @param before - The baseline arm
 * @param after - The compared arm
 * @returns That command's verdict
 */
function verdictOf(before: CrawlCommandStats, after: CrawlCommandStats) {
  const envelope = (command: CrawlCommandStats) =>
    makeReport({ facet: CRAWL_FACET, body: { commands: [command], load: CLEAN_LOAD } });
  const result = compareCrawl(envelope(before), envelope(after), OPTIONS);
  if (!result.ok) throw new Error(`the comparison was refused: ${result.refusal}`);
  const command = result.commands[0];
  if (command === undefined) throw new Error('the comparison produced no command');
  return command.verdict;
}

describe('compareCrawl — arms measured by different instruments', () => {
  it('refuses a comparison whose compared arm gained a bracket', () => {
    // 56ms of `git ls-files` that the baseline build charged nowhere. Every row
    // is identical; only the total moved, and it moved because the instrument
    // widened. Without this refusal the verdict is `changed` and the delta reads
    // as a 56ms regression in `vat audit`.
    const verdict = verdictOf(row(OLD_CHARGES, 1.1), row(NEW_CHARGES, 57.1));

    expect(verdict.kind).toBe('unmeasurable');
    if (verdict.kind !== 'unmeasurable') return;
    expect(verdict.reason).toContain('different instruments');
    // Names WHAT is missing and on WHICH side. "Versions differ" was the old
    // answer and it sent a reader to check their own invocation.
    expect(verdict.reason).toContain("stratum 'shared'");
    expect(verdict.reason).toContain("'git-tracker:initialize'");
    expect(verdict.reason).toContain('baseline build cannot charge');
  });

  it('refuses in the other direction too, and says which side is short', () => {
    // Rolling BACK onto an older build is the same hazard with the arms swapped,
    // and it is the likelier accident: `--instrument-b` is the one people point
    // at a checkout.
    const verdict = verdictOf(row(NEW_CHARGES, 57.1), row(OLD_CHARGES, 1.1));

    expect(verdict.kind).toBe('unmeasurable');
    if (verdict.kind !== 'unmeasurable') return;
    expect(verdict.reason).toContain('compared build cannot charge');
  });

  it('compares normally when both arms carry the same brackets', () => {
    // The control. If this said `unmeasurable` the caveat would be refusing
    // everything, which is a way of passing the two tests above while being
    // useless — an always-on guard cannot distinguish a real mismatch from any
    // other run.
    const verdict = verdictOf(row(NEW_CHARGES, 57.1), row(NEW_CHARGES, 57.4));

    expect(verdict.kind).toBe('unchanged');
  });

  it('refuses BEFORE the attribution cascade, so the reason is the true one', () => {
    // A build without the bracket produces no row for it, so an arm can be both
    // "different instrument" and "crawled nothing" at once. The instrument
    // mismatch is the more useful answer: it names something the operator can
    // act on, where `nothing-crawled` invites them to go looking at the subject.
    const empty: CrawlCommandStats = {
      ...row(OLD_CHARGES, 0),
      attribution: 'nothing-crawled',
      entries: [],
      strata: [],
      totalCalls: 0,
    };
    const verdict = verdictOf(empty, row(NEW_CHARGES, 57.1));

    expect(verdict.kind).toBe('unmeasurable');
    if (verdict.kind !== 'unmeasurable') return;
    expect(verdict.reason).toContain('different instruments');
    expect(verdict.reason).not.toContain('never reached a contributor');
  });
});
