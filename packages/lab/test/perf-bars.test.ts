/**
 * A pass bar compares two arms, and holds only when it holds on the median AND
 * on the min. The two statistics answer different questions — the typical run
 * and the best the machine could do — and a bar that holds on one and not the
 * other is INCONCLUSIVE, never passed. Ties pass under `≤` and fail under `<`.
 *
 * A bar is written `<build>:<sequence>:<state> <=|< <factor>*<build>:<sequence>:<state>`
 * — the `--arm` spelling on both sides, and a factor that is never implied.
 */

import { describe, expect, it } from 'vitest';

import { type BarSide, judgeBar, judgeBars, parseBar, renderBars } from '../src/facets/perf/bars.js';

/** An arm whose median and min are the same number, so one statistic can be moved alone. */
function side(medianMs: number, minMs = medianMs): BarSide {
  return { medianMs, minMs };
}

describe('judgeBar', () => {
  it('passes when the bar holds on both the median and the min', () => {
    expect(judgeBar(side(90, 80), '<=', side(100, 95), 1).verdict).toBe('pass');
  });

  it('fails when the bar fails on both', () => {
    expect(judgeBar(side(110, 100), '<=', side(100, 95), 1).verdict).toBe('fail');
  });

  it('is INCONCLUSIVE when the median holds and the min does not', () => {
    const judged = judgeBar(side(90, 99), '<=', side(100, 95), 1);

    expect(judged).toEqual({ verdict: 'inconclusive', median: true, min: false });
  });

  it('is INCONCLUSIVE when the min holds and the median does not', () => {
    const judged = judgeBar(side(110, 80), '<=', side(100, 95), 1);

    expect(judged).toEqual({ verdict: 'inconclusive', median: false, min: true });
  });

  it('passes a tie under ≤ and fails the same tie under <', () => {
    expect(judgeBar(side(100), '<=', side(100), 1).verdict).toBe('pass');
    expect(judgeBar(side(100), '<', side(100), 1).verdict).toBe('fail');
  });

  it('passes a tie at a NON-1 factor under ≤ and fails it under <, whatever the float product rounds to', () => {
    // 1.15 × 100 is 114.99999999999999 in binary floating point: a bare `<=` fails this tie.
    expect(judgeBar(side(115), '<=', side(100), 1.15).verdict).toBe('pass');
    expect(judgeBar(side(115), '<', side(100), 1.15).verdict).toBe('fail');
    // …and a real difference is still a difference.
    expect(judgeBar(side(115.001), '<=', side(100), 1.15).verdict).toBe('fail');
  });

  it('scales the right-hand arm by the bar factor on both statistics', () => {
    // 114 ≤ 1.15 × 100 and 103 ≤ 1.15 × 90; neither holds unscaled.
    expect(judgeBar(side(114, 103), '<=', side(100, 90), 1.15).verdict).toBe('pass');
    expect(judgeBar(side(114, 103), '<=', side(100, 90), 1).verdict).toBe('fail');
  });

  it('refuses a factor that is not a positive finite number', () => {
    for (const factor of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => judgeBar(side(1), '<=', side(1), factor)).toThrow(/factor/u);
    }
  });
});

describe('parseBar', () => {
  it('reads both arms in the --arm spelling, the relation and the factor', () => {
    expect(parseBar('cand:ci-c:cold<=1.15*rc11:ci-a:cold')).toEqual({
      text: 'cand:ci-c:cold<=1.15*rc11:ci-a:cold',
      left: { build: 'cand', arm: 'ci-c', state: 'cold' },
      relation: '<=',
      factor: 1.15,
      right: { build: 'rc11', arm: 'ci-a', state: 'cold' },
    });
    expect(parseBar(' cand:ci-c:warm < 1 * cand:ci-b:warm ')).toMatchObject({ relation: '<', factor: 1 });
  });

  it('refuses a bar comparing an arm with itself — it cannot fail, so it says nothing', () => {
    expect(parseBar('cand:ci-c:cold<=1*cand:ci-c:cold')).toMatch(/compares cand:ci-c:cold with itself/u);
  });

  it('refuses a bar with no factor — a factor is never implied — and anything else malformed', () => {
    expect(parseBar('cand:ci-c:cold<=rc11:ci-a:cold')).toMatch(/factor/u);
    expect(parseBar('cand:ci-c:tepid<=1*rc11:ci-a:cold')).toMatch(/expects/u);
    expect(parseBar('cand:ci-c:cold>=1*rc11:ci-a:cold')).toMatch(/expects/u);
    expect(parseBar('cand:ci-c:cold<=0*rc11:ci-a:cold')).toMatch(/factor/u);
  });
});

describe('judgeBars', () => {
  const clean = { violation: null };
  const arm = (build: string, name: string, medianMs: number, minMs: number, repetitions: readonly { readonly violation: string | null }[] = Array.from({ length: 5 }, () => clean)) => ({
    build,
    arm: name,
    state: 'cold' as const,
    summary: { medianMs, minMs },
    failure: null,
    repetitions,
  });
  const report = {
    inputs: {
      env: { set: { VAT_PROJECTION_STORE: 'off' }, unset: ['NODE_OPTIONS'] },
      expectedExits: [{ build: 'cand', sequence: 'ci-c', step: 'validate-ci', exit: 1 }],
      prerequisites: ['npm ci'],
      timeoutMs: 60_000,
    },
    builds: [
      { alias: 'rc11', source: { kind: 'dist', path: '/builds/rc11' }, instrument: { version: '0.2.0-rc.11', commit: null, dirty: null, closure: 'a'.repeat(64) } },
      { alias: 'cand', source: { kind: 'tree', path: '/work/vat' }, instrument: { version: '0.2.0', commit: 'abcdef0123456789', dirty: false, closure: 'b'.repeat(64) } },
    ],
    load: { before: 1, after: 2, cpus: 8, available: true, contaminated: false },
    arms: [
      arm('rc11', 'ci-a', 100, 90),
      arm('cand', 'ci-c', 110, 100),
      arm('cand', 'ci-b', 105, 101),
      { build: 'rc11', arm: 'ci-b', state: 'cold' as const, summary: null, failure: "1 of 5 repeats failed — step 'x' exited 1", repetitions: [] },
    ],
  };
  const bar = (text: string) => {
    const parsed = parseBar(text);
    if (typeof parsed === 'string') throw new Error(parsed);
    return parsed;
  };

  it('judges each bar against the report’s arms', () => {
    const judged = judgeBars(report, [bar('cand:ci-c:cold<=1.15*rc11:ci-a:cold'), bar('cand:ci-b:cold<=1*cand:ci-c:cold')]);

    expect(judged.ok ? judged.results.map((result) => result.verdict) : judged.refusal).toEqual(['pass', 'inconclusive']);
  });

  it('fails a bar over an arm with no measurement, giving the arm’s failure', () => {
    const judged = judgeBars(report, [bar('rc11:ci-b:cold<=1*rc11:ci-a:cold')]);

    expect(judged.ok ? judged.results[0] : judged.refusal).toMatchObject({
      verdict: 'fail',
      reason: "rc11:ci-b:cold has no measurement: 1 of 5 repeats failed — step 'x' exited 1",
    });
  });

  it('refuses a report holding an unfailed arm of fewer than 5 repetitions — not a measurement a bar may read', () => {
    const short = { ...report, arms: [...report.arms, arm('cand', 'ci-a', 1, 1, [clean, clean, clean, clean])] };

    expect(judgeBars(short, [bar('cand:ci-c:cold<=1.15*rc11:ci-a:cold')])).toEqual({
      ok: false,
      refusal: 'cand:ci-a:cold has 4 repetition(s); a judged arm needs at least 5',
    });
  });

  it('refuses a report whose unfailed arm holds a repetition that broke its rule', () => {
    const broken = [...Array.from({ length: 4 }, () => clean), { violation: "step 'x' reports population 'store' though the arm turned the store off" }];
    const violated = { ...report, arms: [...report.arms, arm('cand', 'ci-a', 1, 1, broken)] };

    expect(judgeBars(violated, [bar('cand:ci-c:cold<=1.15*rc11:ci-a:cold')])).toEqual({
      ok: false,
      refusal: expect.stringMatching(/^cand:ci-a:cold repetition 5 broke its rule: step 'x'/u) as unknown,
    });
  });

  it('refuses a bar naming an arm the report does not hold', () => {
    const judged = judgeBars(report, [bar('cand:ci-a:warm<=1*rc11:ci-a:cold')]);

    expect(judged.ok ? '' : judged.refusal).toMatch(/cand:ci-a:warm.*not in the report/u);
  });

  it('renders one line per bar with its verdict and both statistics', () => {
    const judged = judgeBars(report, [bar('cand:ci-b:cold<=1*cand:ci-c:cold')]);
    if (!judged.ok) throw new Error(judged.refusal);

    expect(renderBars(report, judged.results).split('\n').at(-1)).toBe(
      'INCONCLUSIVE  cand:ci-b:cold<=1*cand:ci-c:cold  (median holds, min does not — re-run on a quiet machine)',
    );
  });

  /** @returns The judged bar `cand:ci-c:cold<=1.15*rc11:ci-a:cold`, and its rendering over `report` */
  const headerCase = (): { results: Parameters<typeof renderBars>[1]; rendered: string } => {
    const judged = judgeBars(report, [bar('cand:ci-c:cold<=1.15*rc11:ci-a:cold')]);
    if (!judged.ok) throw new Error(judged.refusal);
    return { results: judged.results, rendered: renderBars(report, judged.results) };
  };

  it('heads the verdicts with what every alias WAS and the machine load the arms ran under', () => {
    const { rendered } = headerCase();

    expect(rendered).toMatch(/^ {2}rc11: vat 0\.2\.0-rc\.11 .*closure a{12}\) from dist:\/builds\/rc11$/mu);
    expect(rendered).toMatch(/^ {2}cand: vat 0\.2\.0 \(abcdef01/mu);
    expect(rendered).toMatch(/^Machine load: clean/mu);
  });

  it('heads the verdicts with every input that decided the numbers', () => {
    const { results, rendered } = headerCase();

    expect(rendered).toContain(
      [
        'Inputs:',
        '  --env VAT_PROJECTION_STORE=off',
        '  --unset NODE_OPTIONS',
        '  --expect-exit cand:ci-c:validate-ci=1',
        '  --prerequisite npm ci',
        '  --timeout-ms 60000',
      ].join('\n'),
    );
    const none = renderBars({ ...report, inputs: { env: { set: {}, unset: [] }, expectedExits: [], prerequisites: [], timeoutMs: null } }, results);
    expect(none).toContain('Inputs: none — no --env, --unset, --expect-exit, --prerequisite or --timeout-ms');
  });
});
