/**
 * A gap is an edit arm's median minus the median of the clean warm arm of the
 * SAME build in the same report, and a gap bar holds that gap to another gap
 * or to seconds — judged only outside the noise.
 */

import { describe, expect, it } from 'vitest';

import { collectBar } from '../src/bin/vat-lab.js';
import { parseArmName } from '../src/facets/perf/arms-report-file.js';
import { armGaps, type GapArm, type GapBar, judgeGapBars, marginalCosts, parseGapBar } from '../src/facets/perf/gaps.js';

/** Five clean repetitions: the fewest a judge reads as a measurement. */
const FIVE = Array.from({ length: 5 }, () => ({ violation: null }));

/**
 * @param name - The arm in `--arm` spelling
 * @param medianMs - Its median
 * @param iqrMs - Its IQR
 * @returns A measured, complete arm
 */
function arm(name: string, medianMs: number, iqrMs = 1): GapArm {
  const parsed = parseArmName(name);
  if (parsed === null) throw new Error(`fixture arm '${name}' does not parse`);
  return { ...parsed, summary: { medianMs, iqrMs }, failure: null, repetitions: FIVE };
}

/**
 * @param text - A gap bar
 * @returns It, parsed
 */
function bar(text: string): GapBar {
  const parsed = parseGapBar(text);
  if (typeof parsed === 'string') throw new Error(parsed);
  return parsed;
}

/**
 * @param arms - A report's arms
 * @param text - One gap bar
 * @returns Its verdict, or the refusal
 */
function verdictOf(arms: readonly GapArm[], text: string): string {
  const judged = judgeGapBars(arms, [bar(text)]);
  return judged.ok ? (judged.results[0]?.verdict ?? 'none') : judged.refusal;
}

/** Two builds, each with a clean arm and two edit arms. main's clean arm comes first. */
const REPORT: readonly GapArm[] = [
  arm('main:ci-c:warm', 1300),
  arm('main:ci-c:warm-edit1', 1800),
  arm('main:ci-c:warm-edit50', 6700),
  arm('cand:ci-c:warm', 1000),
  arm('cand:ci-c:warm-edit1', 1600),
  arm('cand:ci-c:warm-edit50', 3050),
];

describe('armGaps and marginalCosts', () => {
  it("takes each edit arm's gap against its own build's clean arm, and the marginal per-file cost", () => {
    const gaps = armGaps(REPORT);

    expect(gaps.map((gap) => [gap.build, gap.state, gap.gapMs])).toEqual([
      ['main', 'warm-edit1', 500],
      ['main', 'warm-edit50', 5400],
      ['cand', 'warm-edit1', 600],
      ['cand', 'warm-edit50', 2050],
    ]);
    expect(marginalCosts(gaps).map((cost) => [cost.build, cost.state, cost.perFileMs])).toEqual([
      ['main', 'warm-edit50', 100],
      ['cand', 'warm-edit50', 1450 / 49],
    ]);
  });

  it('carries each arm its marginal read with its own IQR', () => {
    const arms = [arm('b:ci-c:warm', 1000, 3), arm('b:ci-c:warm-edit1', 1500, 5), arm('b:ci-c:warm-edit10', 2400, 7)];

    expect(marginalCosts(armGaps(arms))).toEqual([
      { build: 'b', sequence: 'ci-c', state: 'warm-edit10', perFileMs: 100, oneFileIqrMs: 5, wideIqrMs: 7, cleanIqrMs: 3 },
    ]);
  });

  it('records no gap for an edit arm with no same-build clean arm', () => {
    expect(armGaps([arm('main:ci-c:warm-edit1', 1800), arm('cand:ci-c:warm', 1000)])).toEqual([]);
  });
});

describe('parseGapBar', () => {
  it('reads both forms', () => {
    expect(bar('gap(cand:ci-c:warm-edit1) <= 0.66*gap(main:ci-c:warm-edit1)').bound).toEqual({
      kind: 'factor',
      factor: 0.66,
      right: { build: 'main', arm: 'ci-c', state: { warm: 'edit', count: 1, kind: 'modify' } },
    });
    expect(bar('gap(cand:ci-c:warm-edit1)<=0.5s').bound).toEqual({ kind: 'seconds', seconds: 0.5 });
  });

  it('is what perf bars --bar routes a gap( bar to, beside the ratio bars', () => {
    const bars = collectBar('cand:ci-c:warm<=1.05*main:ci-c:warm', collectBar('gap(cand:ci-c:warm-edit1) <= 0.5s', undefined));

    expect(bars.map((each) => ('bound' in each ? 'gap' : 'ratio'))).toEqual(['gap', 'ratio']);
  });

  it('refuses a side that is no edit arm, a self comparison and a malformed bar', () => {
    expect(parseGapBar('gap(cand:ci-c:warm)<=1*gap(main:ci-c:warm-edit1)')).toMatch(/is not an edit arm/u);
    expect(parseGapBar('gap(cand:ci-c:warm-edit1)<=1*gap(cand:ci-c:warm-edit1)')).toMatch(/with itself/u);
    expect(parseGapBar('gap(cand:ci-c:warm-edit1)<0.5s')).toMatch(/expects gap/u);
  });
});

describe('judgeGapBars', () => {
  it('passes and fails the factor form on constructed medians', () => {
    // cand 600 against main 500: 600 <= 1.3*500 holds, 600 <= 1.1*500 does not.
    expect(verdictOf(REPORT, 'gap(cand:ci-c:warm-edit1)<=1.3*gap(main:ci-c:warm-edit1)')).toBe('pass');
    expect(verdictOf(REPORT, 'gap(cand:ci-c:warm-edit1)<=1.1*gap(main:ci-c:warm-edit1)')).toBe('fail');
  });

  it("passes and fails the seconds form against the edit arm's own build's clean arm", () => {
    expect(verdictOf(REPORT, 'gap(cand:ci-c:warm-edit1)<=0.7s')).toBe('pass');
    // cand's gap is 600 ms; against main's clean arm (1300) it would read 300 ms and pass.
    expect(verdictOf(REPORT, 'gap(cand:ci-c:warm-edit1)<=0.5s')).toBe('fail');
  });

  it('is noise-bound, never passed, when an arm it reads has an IQR not under the margin', () => {
    const noisy = REPORT.map((each) => (each.build === 'cand' && each.state === 'warm' ? arm('cand:ci-c:warm', 1000, 150) : each));

    // gap 600 against 0.7 s: a margin of 100 ms, under cand's clean IQR of 150.
    expect(verdictOf(noisy, 'gap(cand:ci-c:warm-edit1)<=0.7s')).toBe('noise-bound');
  });

  it("gates the factor form on the right gap's arms with their IQR scaled by the factor", () => {
    // cand 600 against 1.3*500 = 650: a margin of 50 ms. main's one-file IQR of 40 scales to 52.
    const scaled = REPORT.map((each) => (each === REPORT[1] ? arm('main:ci-c:warm-edit1', 1800, 40) : each));

    expect(verdictOf(REPORT, 'gap(cand:ci-c:warm-edit1)<=1.3*gap(main:ci-c:warm-edit1)')).toBe('pass');
    expect(verdictOf(scaled, 'gap(cand:ci-c:warm-edit1)<=1.3*gap(main:ci-c:warm-edit1)')).toBe('noise-bound');
  });

  it('refuses a gap bar naming an edit arm with no same-build clean arm in the invocation', () => {
    const noClean = REPORT.filter((each) => !(each.build === 'cand' && each.state === 'warm'));

    expect(verdictOf(noClean, 'gap(cand:ci-c:warm-edit1)<=0.7s')).toMatch(/no same-build clean arm: cand:ci-c:warm is not in the invocation/u);
  });

  it('fails a bar whose arm failed, naming why', () => {
    const failed = REPORT.map((each) =>
      each.build === 'cand' && each.state !== 'warm' ? { ...each, summary: null, failure: 'priming failed' } : each,
    );
    const judged = judgeGapBars(failed, [bar('gap(cand:ci-c:warm-edit1)<=0.7s')]);

    expect(judged.ok && judged.results[0]).toMatchObject({ verdict: 'fail', detail: expect.stringMatching(/priming failed/u) });
  });
});
