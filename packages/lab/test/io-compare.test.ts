/**
 * `compareIo` is an EXACT-EQUALITY comparator, and every case below exists to
 * defend one of the two things that makes that honest.
 *
 * **Why exact equality.** Call counts are deterministic. Measured on `vat
 * resources scan docs/`: 436 user / 6,371 loader on three consecutive warm runs,
 * and 568 user / 6,371 loader on three consecutive cold runs — the same numbers
 * every time. So any difference in a count IS a change, there is no significance
 * threshold, and there is deliberately no tolerance knob to port over from
 * `perf`. A test that asserts "unchanged" is therefore asserting that two
 * numbers were literally equal.
 *
 * **Why that needs a warrant.** Determinism is a property of the measured code,
 * not a promise the lab makes on its behalf. `stable` is the row's own answer to
 * "did my repeats agree?", and an exact delta read off a row that answered
 * `false` (they disagreed) or `null` (fewer than two repeats, so nothing could
 * disagree) is a well-formed number with nothing behind it. Those rows get their
 * own verdict, and four cases below hold that line.
 *
 * Every zero-assertion carries a positive control in the same file: before any
 * case asserts "no change was reported", another case proves the same harness
 * DOES report a change when one exists. A fixture that cannot distinguish the
 * two answers makes a green test that proves nothing.
 */

import { describe, expect, it } from 'vitest';

import { compareIo, type IoCommandVerdict } from '../src/facets/io/compare.js';
import {
  IO_FACET,
  IO_FACET_VERSION,
  type IoCommandStats,
  type IoSite,
} from '../src/facets/io/types.js';

import {
  compareOneCommand,
  ioBody,
  ioCommand,
  ioReport,
  ioSite,
} from './io-fixtures.js';
import { BUSY_LOAD, COORDINATE, makeReport } from './report-fixtures.js';

/** A second subject, so axis A can be moved. */
const OTHER_SUBJECT = { id: 'other-project', source: '/srv/other-project' };

/** A second instrument build, so axis C can be moved. */
const OTHER_INSTRUMENT = { version: '0.1.43', commit: '2'.repeat(40) };

/**
 * An io report at a coordinate varied from the shared baseline.
 *
 * @param over - Coordinate axes to replace
 * @returns A one-command io report at the varied coordinate
 */
function reportAt(over: Partial<typeof COORDINATE>): ReturnType<typeof ioReport> {
  return ioReport([ioCommand()], { coordinate: { ...COORDINATE, ...over } });
}

/**
 * The verdict for the single command in a two-row comparison.
 *
 * @param before - The baseline row
 * @param after - The compared row
 * @returns That command's verdict
 * @throws When no row came back, which would mean the pairing dropped it
 */
function verdictFor(before: IoCommandStats, after: IoCommandStats): IoCommandVerdict {
  const row = compareOneCommand(before, after).commands[0];
  if (row === undefined) throw new Error('comparison produced no command rows');
  return row.verdict;
}

/**
 * The refusal text, or an empty string when the comparison unexpectedly succeeded.
 *
 * @param result - Whatever compareIo returned
 * @returns The refusal, or `''`
 */
function refusalOf(result: ReturnType<typeof compareIo>): string {
  return result.ok ? '' : result.refusal;
}

describe('compareIo — the schema gate', () => {
  it('refuses two reports of different facets', () => {
    const result = compareIo(ioReport([ioCommand()]), makeReport());

    expect(result.ok).toBe(false);
    expect(refusalOf(result)).toContain('different facets');
  });

  it('refuses two io reports whose body schema versions differ', () => {
    const older = ioReport([ioCommand()], { facetVersion: IO_FACET_VERSION + 1 });

    const result = compareIo(ioReport([ioCommand()]), older);

    expect(result.ok).toBe(false);
    expect(refusalOf(result)).toContain('body schema moved');
  });

  it('refuses reports of a matching but wrong facet', () => {
    // Both sides say `perf`, so the shared schema gate is satisfied and only
    // compareIo's own check can catch that it holds the wrong kind of report.
    const result = compareIo(makeReport(), makeReport());

    expect(result.ok).toBe(false);
    expect(refusalOf(result)).toContain(`not '${IO_FACET}'`);
  });

  it('names the baseline when its body does not match the io schema', () => {
    const broken = makeReport({ facet: IO_FACET, facetVersion: IO_FACET_VERSION, body: {} });

    expect(refusalOf(compareIo(broken, ioReport([ioCommand()])))).toContain('baseline');
  });

  it('names the compared side when ITS body does not match the io schema', () => {
    // The mirror of the case above: a refusal that always said "baseline" would
    // pass that test while telling every reader the wrong file to re-capture.
    const broken = makeReport({ facet: IO_FACET, facetVersion: IO_FACET_VERSION, body: {} });

    expect(refusalOf(compareIo(ioReport([ioCommand()]), broken))).toContain('compared');
  });
});

describe('compareIo — the coordinate gate', () => {
  it('CONTROL: one moved axis compares, and names which one moved', () => {
    // Without this, the multi-axis refusal below could be produced by a
    // comparator that refuses everything.
    const result = compareIo(reportAt({}), reportAt({ instrument: OTHER_INSTRUMENT }));

    expect(result.ok).toBe(true);
    expect(result.ok ? result.axis : null).toBe('instrument');
  });

  it('refuses when two axes moved at once', () => {
    const moved = reportAt({ subject: OTHER_SUBJECT, instrument: OTHER_INSTRUMENT });

    const result = compareIo(reportAt({}), moved);

    expect(result.ok).toBe(false);
    expect(refusalOf(result)).toContain('2 axes moved');
  });

  it('compares two moved axes when the caller says out loud that it wants to', () => {
    const moved = reportAt({ subject: OTHER_SUBJECT, instrument: OTHER_INSTRUMENT });

    const result = compareIo(reportAt({}), moved, { allowMultiAxis: true });

    expect(result.ok).toBe(true);
    expect(result.ok ? result.axis : 'unset').toBeNull();
  });

  it('reports a null axis when nothing moved at all', () => {
    expect(compareOneCommand(ioCommand(), ioCommand()).axis).toBeNull();
  });
});

describe('compareIo — changed and unchanged', () => {
  it('CONTROL: a one-call difference in the user total is reported as changed', () => {
    // The positive control for every "unchanged" assertion below. One call is the
    // smallest possible delta, and an exact-equality comparator must see it.
    const after = ioCommand({ userCalls: 437, sites: [ioSite({ count: 437 })] });

    const verdict = verdictFor(ioCommand(), after);

    expect(verdict.kind).toBe('changed');
    expect(verdict.kind === 'changed' ? verdict.movement.totals.userCalls : null).toEqual({
      before: 436,
      after: 437,
      delta: 1,
    });
  });

  it('reports two identical rows as unchanged, carrying the totals anyway', () => {
    const verdict = verdictFor(ioCommand(), ioCommand());

    expect(verdict.kind).toBe('unchanged');
    // The totals travel with `unchanged` too: a renderer that cannot show
    // loaderCalls on an unchanged row cannot obey its own no-hidden-aggregate
    // rule, and 6,371 of 6,411 calls being the loader's is the whole context.
    expect(verdict.kind === 'unchanged' ? verdict.movement.totals.loaderCalls.after : null).toBe(
      6371,
    );
    expect(verdict.kind === 'unchanged' ? verdict.movement.sites : null).toEqual([]);
  });

  it('sees a loader-only difference, which no site row would show', () => {
    const verdict = verdictFor(ioCommand(), ioCommand({ loaderCalls: 6400 }));

    expect(verdict.kind).toBe('changed');
    expect(verdict.kind === 'changed' ? verdict.movement.totals.loaderCalls.delta : null).toBe(29);
    expect(verdict.kind === 'changed' ? verdict.movement.sites : null).toEqual([]);
  });

  it('sees a process-count difference, which is the counter failing to propagate', () => {
    const verdict = verdictFor(ioCommand(), ioCommand({ processes: 1 }));

    expect(verdict.kind).toBe('changed');
    expect(verdict.kind === 'changed' ? verdict.movement.totals.processes.delta : null).toBe(-1);
  });
});

describe('compareIo — per-site movement', () => {
  /** The baseline half of a split whose per-site counts move but whose totals do not. */
  const SPLIT_BEFORE = ioCommand({
    sites: [
      ioSite({ site: 'a.js:1', count: 200, distinctArgs: 200 }),
      ioSite({ site: 'b.js:2', count: 236, distinctArgs: 236 }),
    ],
  });

  /** The other half: 100 calls moved from the first site to the second. */
  const SPLIT_AFTER = ioCommand({
    sites: [
      ioSite({ site: 'a.js:1', count: 100, distinctArgs: 100 }),
      ioSite({ site: 'b.js:2', count: 336, distinctArgs: 336 }),
    ],
  });

  it('CONTROL: the split fixture holds every total identical', () => {
    // Without this the case below could pass on a comparator that noticed a
    // total after all — the fixture has to be proven incapable of that.
    expect([SPLIT_BEFORE.userCalls, SPLIT_BEFORE.loaderCalls, SPLIT_BEFORE.processes]).toEqual([
      SPLIT_AFTER.userCalls,
      SPLIT_AFTER.loaderCalls,
      SPLIT_AFTER.processes,
    ]);
  });

  it('reports work moving BETWEEN sites even though every total is identical', () => {
    const verdict = verdictFor(SPLIT_BEFORE, SPLIT_AFTER);

    expect(verdict.kind).toBe('changed');
    const sites = verdict.kind === 'changed' ? verdict.movement.sites : [];
    expect(sites.map((site) => [site.site, site.kind, site.count.delta])).toEqual([
      ['a.js:1', 'changed', -100],
      ['b.js:2', 'changed', 100],
    ]);
  });

  it('reports a site that appeared and a site that vanished', () => {
    const before = ioCommand({ sites: [ioSite({ site: 'gone.js:1', count: 436 })] });
    const after = ioCommand({ sites: [ioSite({ site: 'new.js:9', count: 436 })] });

    const verdict = verdictFor(before, after);

    const sites = verdict.kind === 'changed' ? verdict.movement.sites : [];
    expect(sites.map((site) => [site.site, site.kind, site.count.before, site.count.after])).toEqual(
      [
        ['gone.js:1', 'removed', 436, 0],
        ['new.js:9', 'added', 0, 436],
      ],
    );
  });

  it('reports a cache breaking: the same calls, over far fewer distinct files', () => {
    // The N+1 signature. `count` did not move at all, so a comparator that only
    // subtracted counts would call this unchanged.
    const after = ioCommand({ sites: [ioSite({ distinctArgs: 1 })] });

    const verdict = verdictFor(ioCommand(), after);

    expect(verdict.kind).toBe('changed');
    const sites = verdict.kind === 'changed' ? verdict.movement.sites : [];
    expect(sites.map((site) => [site.count.delta, site.distinctArgs?.delta])).toEqual([[0, -435]]);
  });
});

describe('compareIo — distinctArgs is a bound, not an exact number', () => {
  it('CONTROL: two uncapped sites at equal process counts yield a real delta', () => {
    const after = ioCommand({ sites: [ioSite({ distinctArgs: 400 })] });

    const verdict = verdictFor(ioCommand(), after);
    const movement = verdict.kind === 'changed' ? verdict.movement : null;

    expect(movement?.sites[0]?.distinctArgs?.delta).toBe(-36);
    expect(movement?.unreadableDistinctArgs).toBe(0);
    expect(movement?.distinctArgsCaveat).toBeNull();
  });

  it('refuses to subtract when either side capped its argument tracking', () => {
    // Capped means the reported number is a FLOOR. Subtracting a floor from a
    // bound produces a number with no direction, and reporting it as an N+1
    // appearing or disappearing would be a fabricated finding. The count beside
    // it is a plain sum and still subtracts exactly.
    const after = ioCommand({
      userCalls: 400,
      sites: [ioSite({ count: 400, distinctArgs: 400, argsCapped: true })],
    });

    const verdict = verdictFor(ioCommand(), after);
    const movement = verdict.kind === 'changed' ? verdict.movement : null;

    expect(movement?.sites[0]?.count.delta).toBe(-36);
    expect(movement?.sites[0]?.distinctArgs).toBeNull();
    expect(movement?.unreadableDistinctArgs).toBe(1);
    expect(movement?.distinctArgsCaveat).toContain('capped');
  });

  it('carries the caveat even when nothing else moved, so silence is not read as clean', () => {
    // Counts identical, distinct arguments unreadable. The verdict is honestly
    // `unchanged` — nothing WAS observed to move — but a comparison that dropped
    // the caveat here would be indistinguishable from one that checked
    // everything and found it clean.
    const after = ioCommand({ sites: [ioSite({ distinctArgs: 400, argsCapped: true })] });

    const verdict = verdictFor(ioCommand(), after);
    const movement = verdict.kind === 'unchanged' ? verdict.movement : null;

    expect(verdict.kind).toBe('unchanged');
    expect(movement?.unreadableDistinctArgs).toBe(1);
    expect(movement?.distinctArgsCaveat).toContain('capped');
  });

  it('refuses to subtract when the two sides merged a different number of processes', () => {
    // distinctArgs is summed per process, so two processes reading one file count
    // it twice. That inflation is only comparable when both sides inflated it the
    // same way; when the process counts differ, the difference may be the merge.
    const after = ioCommand({ processes: 3, sites: [ioSite({ distinctArgs: 500 })] });

    const verdict = verdictFor(ioCommand(), after);
    const movement = verdict.kind === 'changed' ? verdict.movement : null;

    expect(movement?.unreadableDistinctArgs).toBe(1);
    expect(movement?.distinctArgsCaveat).toContain('processes');
  });
});

/** The real spawn site the defect was found on. */
const GIT_UTILS_SITE = 'packages/utils/dist/git-utils.js:60';

/** The phrase the caveat must carry when no reading was taken at a site. */
const NO_READING_PHRASE = 'does not identify the work';

/**
 * A spawn site, as the counter now reports one: counted, but never identified.
 *
 * @param over - What the case varies
 * @returns The site row
 */
function spawnSite(over: Partial<IoSite> = {}): IoSite {
  return ioSite({
    method: 'child_process.spawnSync',
    site: GIT_UTILS_SITE,
    count: 8,
    distinctArgs: null,
    ...over,
  });
}

describe('compareIo — a body this build does not read', () => {
  it('refuses two reports that AGREE on a facet version this build has moved past', () => {
    // The version gate in the envelope is two-sided: it asks whether the two
    // reports agree with each other, not whether they agree with the build
    // reading them. Two reports captured before `distinctArgs` became nullable
    // agree perfectly — and every spawn row in them says `distinctArgs: 1`,
    // which this build would render as a redundancy ratio. Same rule the dump
    // reader already applies to `dumpVersion`.
    const stale = { facetVersion: IO_FACET_VERSION - 1 };
    const result = compareIo(ioReport([ioCommand()], stale), ioReport([ioCommand()], stale));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.refusal).toMatch(/^REFUSED:/);
    expect(result.refusal).toContain('facetVersion');
  });
});

describe('compareIo — a site that kept no distinct-argument reading', () => {
  it('subtracts the counts but withholds the distinctArgs delta, and says why', () => {
    const before = ioCommand({ userCalls: 8, sites: [spawnSite()] });
    const after = ioCommand({ userCalls: 2, sites: [spawnSite({ count: 2 })] });

    const verdict = verdictFor(before, after);
    const movement = verdict.kind === 'changed' ? verdict.movement : null;

    expect(movement?.sites[0]?.count.delta).toBe(-6);
    expect(movement?.sites[0]?.distinctArgs).toBeNull();
    expect(movement?.unreadableDistinctArgs).toBe(1);
    expect(movement?.distinctArgsCaveat).toContain(NO_READING_PHRASE);
  });

  it('does not read a missing reading as zero when only one side has one', () => {
    // The dangerous coercion: `null ?? 0` against a real 3 would report a
    // distinct-argument delta of +3 — a fabricated N+1 disappearing.
    const before = ioCommand({ userCalls: 8, sites: [spawnSite()] });
    const after = ioCommand({ userCalls: 8, sites: [spawnSite({ distinctArgs: 3 })] });

    const verdict = verdictFor(before, after);
    const movement = verdict.kind === 'unchanged' ? verdict.movement : null;

    // Under `null ?? 0` the pair reads 0 -> 3, the site is reported as moved and
    // the verdict flips to `changed` on a distinct-argument delta that nobody
    // measured. Nothing moved, and the row says why it could not be checked.
    expect(verdict.kind).toBe('unchanged');
    expect(movement?.sites).toEqual([]);
    expect(movement?.unreadableDistinctArgs).toBe(1);
    expect(movement?.distinctArgsCaveat).toContain(NO_READING_PHRASE);
  });

  it('names every reason when sites are unreadable for different reasons', () => {
    // One site has no reading at all, another capped its tracking. A caveat that
    // named only the first would send a reader looking for the wrong thing at
    // the second.
    const before = ioCommand({
      sites: [spawnSite(), ioSite({ site: 'b.js:2', argsCapped: true })],
    });
    const after = ioCommand({
      sites: [spawnSite({ count: 2 }), ioSite({ site: 'b.js:2', argsCapped: true })],
    });

    const verdict = verdictFor(before, after);
    const movement = verdict.kind === 'changed' ? verdict.movement : null;

    expect(movement?.unreadableDistinctArgs).toBe(2);
    expect(movement?.distinctArgsCaveat).toContain(NO_READING_PHRASE);
    expect(movement?.distinctArgsCaveat).toContain('capped');
  });
});

describe('compareIo — the stable gate', () => {
  /** A row whose numbers differ from the default, so a delta exists to suppress. */
  const MOVED = { userCalls: 402, sites: [ioSite({ count: 402 })] };

  it('CONTROL: with stable true on both sides the same numbers read as changed', () => {
    // Without this control, all four suppression cases below would pass against
    // a comparator that never reported anything as changed.
    expect(verdictFor(ioCommand(), ioCommand(MOVED)).kind).toBe('changed');
  });

  it("refuses a delta when the baseline's own repeats disagreed", () => {
    const verdict = verdictFor(ioCommand({ stable: false }), ioCommand(MOVED));

    expect(verdict.kind).toBe('unwarranted');
    expect(verdict.kind === 'unwarranted' ? verdict.reason : '').toContain('baseline');
  });

  it("refuses a delta when the COMPARED side's repeats disagreed", () => {
    const verdict = verdictFor(ioCommand(), ioCommand({ ...MOVED, stable: false }));

    expect(verdict.kind).toBe('unwarranted');
    expect(verdict.kind === 'unwarranted' ? verdict.reason : '').toContain('compared');
  });

  it('refuses a delta when determinism was never tested — null is not true', () => {
    // The load-bearing case. `null` means fewer than two compared repeats, so
    // nothing could have disagreed; a comparator that read it as `true` would
    // report an exact delta off a row that never demonstrated determinism.
    const verdict = verdictFor(ioCommand(), ioCommand({ ...MOVED, comparedRuns: 1, stable: null }));

    expect(verdict.kind).toBe('unwarranted');
    expect(verdict.kind === 'unwarranted' ? verdict.reason : '').toContain('never tested');
  });

  it('suppresses the verdict even when the numbers happen to be identical', () => {
    // An unstable row that matches is not evidence of stability; it is one draw
    // from a distribution that is known to move. Rendering it green would be the
    // most reassuring possible way to be wrong.
    expect(verdictFor(ioCommand({ stable: false }), ioCommand({ stable: false })).kind).toBe(
      'unwarranted',
    );
  });

  it('keeps the raw movement on an unwarranted row so a reader can still see it', () => {
    const verdict = verdictFor(ioCommand({ stable: null, comparedRuns: 1 }), ioCommand(MOVED));

    expect(verdict.kind === 'unwarranted' ? verdict.movement.totals.userCalls.delta : null).toBe(
      -34,
    );
  });
});

describe('compareIo — nothing to measure', () => {
  it('will not read a delta from a failed baseline', () => {
    const verdict = verdictFor(ioCommand({ failed: true, failure: 'exited 2' }), ioCommand());

    expect(verdict.kind).toBe('unmeasurable');
    expect(verdict.kind === 'unmeasurable' ? verdict.reason : '').toContain('exited 2');
  });

  it('will not read a delta from a failed compared side', () => {
    const verdict = verdictFor(ioCommand(), ioCommand({ failed: true, failure: 'spawn ENOENT' }));

    expect(verdict.kind).toBe('unmeasurable');
    expect(verdict.kind === 'unmeasurable' ? verdict.reason : '').toContain('spawn ENOENT');
  });

  it('will not compare a warm run against a cold one', () => {
    // 436 warm against 568 cold is a 132-call "regression" that is nothing but
    // the cache mode.
    const verdict = verdictFor(ioCommand(), ioCommand({ cache: 'cold', userCalls: 568 }));

    expect(verdict.kind).toBe('unmeasurable');
    expect(verdict.kind === 'unmeasurable' ? verdict.reason : '').toContain('cache mode');
  });

  it('ranks unmeasurable above unwarranted — no measurement outranks no warrant', () => {
    const before = ioCommand({ stable: false, failed: true, failure: 'exited 2' });

    expect(verdictFor(before, ioCommand()).kind).toBe('unmeasurable');
  });
});

describe('compareIo — commands that only exist on one side', () => {
  it('marks a new command added and a dropped command removed', () => {
    const result = compareIo(
      ioReport([ioCommand({ name: 'gone' }), ioCommand({ name: 'both' })]),
      ioReport([ioCommand({ name: 'both' }), ioCommand({ name: 'fresh' })]),
    );

    expect(result.ok).toBe(true);
    const rows = result.ok ? result.commands : [];
    expect(rows.map((row) => [row.name, row.verdict.kind])).toEqual([
      ['both', 'unchanged'],
      ['fresh', 'added'],
      ['gone', 'removed'],
    ]);
    expect(rows.find((row) => row.name === 'fresh')?.before).toBeNull();
    expect(rows.find((row) => row.name === 'gone')?.after).toBeNull();
  });
});

describe('compareIo — contamination', () => {
  it('CONTROL: two quiet captures are not flagged', () => {
    expect(compareOneCommand(ioCommand(), ioCommand()).contaminated).toBe(false);
  });

  it('flags the comparison when either side was captured on a busy machine', () => {
    const busy = makeReport({
      facet: IO_FACET,
      facetVersion: IO_FACET_VERSION,
      body: ioBody([ioCommand()], BUSY_LOAD),
    });

    const result = compareIo(ioReport([ioCommand()]), busy);

    expect(result.ok && result.contaminated).toBe(true);
  });
});
