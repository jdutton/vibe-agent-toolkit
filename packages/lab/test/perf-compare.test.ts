/**
 * `comparePerf` refuses to read a delta off two rows that did different amounts
 * of work, and this suite is about the newest member of that family: the
 * **accepted exit code**.
 *
 * A vat validator exits `0` when the project has no findings and `1` when it
 * does, and both mean "the run finished" (`MeasuredCommandSpec.completedExitCodes`).
 * So a baseline that exited `0` and a candidate that exited `1` are two complete
 * runs — and rendering findings is work the clean side never did. Subtracting
 * their medians produces a perfectly ordinary `faster`/`slower` number that is
 * partly, and invisibly, a finding-count change. That is exactly the silent
 * mis-attribution this package exists to prevent, and it is about to be leaned
 * on for an A/B between two builds of vat where a moved finding count is
 * entirely plausible.
 *
 * Two properties, and the fixtures are built so only one answer can produce each:
 *
 * 1. **The rule fires on the exit code and nothing else.** Every row in the
 *    0-vs-1 case is byte-identical apart from `exitCode` — same cache, same
 *    runs, same samples, so the timing delta is exactly zero and the verdict
 *    would otherwise be `unchanged`. Paired with a same-code control (which must
 *    still reach a normal verdict) and a `1`-vs-`1` case (a findings run against
 *    a findings run is a legitimate comparison), the three can only be told
 *    apart by the field under test.
 * 2. **The order of the checks holds.** A failed row's `exitCode` is `null` by
 *    design, so an exit-code check that ran first would report "differs (null vs
 *    0)" for what is really "the baseline crashed" — the wrong cause, pointing
 *    the reader at the wrong thing to fix. The failure case below pins that, and
 *    a cache case pins that the new check did not displace the existing one.
 *
 * Deliberately NOT a characterisation of the whole comparator: the significance
 * arithmetic has its own suite in `perf-stats.test.ts`, and the coordinate gates
 * have theirs in `coordinate.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import type { ReportEnvelope } from '../src/envelope/envelope.js';
import { comparePerf, type PerfCommandVerdict } from '../src/facets/perf/compare.js';
import {
  PERF_FACET,
  type PerfBody,
  type PerfCommandStats,
} from '../src/facets/perf/types.js';
import type { LoadReadings } from '../src/harness/types.js';

import { makeReport } from './report-fixtures.js';

/** A quiet machine, so contamination is never an accidental variable. */
const QUIET_LOAD: LoadReadings = {
  before: 1,
  after: 1.2,
  cpus: 8,
  available: true,
  contaminated: false,
};

/**
 * One measured command: a clean, warm, three-repeat run with no findings.
 *
 * Every case varies this by exactly the field it is about. The median is well
 * clear of the 10 ms absolute floor so a same-code pair lands on a real verdict
 * rather than `below-resolution`, which would prove nothing about this rule.
 *
 * @param over - Fields to replace
 * @returns A complete command row
 */
function perfRow(over: Partial<PerfCommandStats> = {}): PerfCommandStats {
  return {
    name: 'validate',
    args: ['validate'],
    cache: 'warm',
    runs: 3,
    medianMs: 1000,
    minMs: 990,
    maxMs: 1010,
    iqrMs: 20,
    samplesMs: [990, 1000, 1010],
    exitCode: 0,
    failed: false,
    failure: null,
    ...over,
  };
}

/**
 * A one-command `perf` report at the shared baseline coordinate.
 *
 * Built through `makeReport` so the coordinate stays in one place: both sides of
 * every comparison here sit at the SAME coordinate, so no axis moved and the
 * multi-axis refusal can never fire ahead of the rule under test.
 *
 * @param row - The single measured command
 * @returns A complete `perf` report
 */
function perfReport(row: PerfCommandStats): ReportEnvelope<PerfBody> {
  return makeReport({
    facet: PERF_FACET,
    body: { commands: [row], load: QUIET_LOAD },
  }) as ReportEnvelope<PerfBody>;
}

/**
 * The verdict for the single command shared by two one-row reports.
 *
 * @param before - The baseline row
 * @param after - The compared row
 * @returns That command's verdict
 * @throws When the comparison refused, or produced no row — neither is expected
 *   at a shared coordinate, and a helper that swallowed either would let a test
 *   pass for the wrong reason
 */
function verdictFor(before: PerfCommandStats, after: PerfCommandStats): PerfCommandVerdict {
  const result = comparePerf(perfReport(before), perfReport(after));
  if (!result.ok) throw new Error(`unexpected refusal: ${result.refusal}`);
  const row = result.commands[0];
  if (row === undefined) throw new Error('comparison produced no command rows');
  return row.verdict;
}

/**
 * The reason text of an `unmeasurable` verdict, or `''` for any other kind.
 *
 * Empty rather than throwing so a case can assert on the reason and on the kind
 * independently, and a wrong kind fails on its own assertion rather than as an
 * exception from this helper.
 *
 * @param verdict - Any verdict
 * @returns The reason, or `''`
 */
function reasonOf(verdict: PerfCommandVerdict): string {
  return verdict.kind === 'unmeasurable' ? verdict.reason : '';
}

describe('comparePerf — rows that agree on their exit code still compare', () => {
  it('CONTROL: two identical clean rows reach a normal verdict, not unmeasurable', () => {
    // Without this, a check that returned a reason unconditionally would satisfy
    // every other case in this file while making the comparator useless.
    expect(verdictFor(perfRow(), perfRow()).kind).toBe('unchanged');
  });

  it('CONTROL: a real speed-up between two clean rows is still reported as changed', () => {
    // The other half of the control: `unchanged` alone could be produced by a
    // comparator that never says anything moved.
    const verdict = verdictFor(perfRow(), perfRow({ medianMs: 500, samplesMs: [490, 500, 510] }));

    expect(verdict.kind).toBe('changed');
  });

  it('compares a findings run against a findings run', () => {
    // Both exited 1: both rendered findings, both did the same kind of work.
    // Refusing this pair would make the rule useless on any real project, where
    // a validator exits 1 far more often than it exits 0.
    const withFindings = perfRow({ exitCode: 1 });

    expect(verdictFor(withFindings, withFindings).kind).toBe('unchanged');
  });
});

describe('comparePerf — rows whose accepted exit codes differ', () => {
  it('refuses a delta between a clean baseline and a candidate with findings', () => {
    // The ONLY difference between these two rows is the exit code: same cache,
    // same runs, same samples, so the timing delta is exactly 0 ms and the
    // verdict would be `unchanged` if the code were ignored. This fixture can
    // therefore only pass because of `exitCode`.
    const verdict = verdictFor(perfRow(), perfRow({ exitCode: 1 }));

    expect(verdict.kind).toBe('unmeasurable');
    expect(reasonOf(verdict)).toContain('accepted exit codes differ (0 vs 1)');
  });

  it('says what to do about it, not merely that it happened', () => {
    // An `unmeasurable` a reader cannot act on gets overridden the first time it
    // is inconvenient. The reason has to point at the finding count.
    expect(reasonOf(verdictFor(perfRow(), perfRow({ exitCode: 1 })))).toContain(
      'why the finding count moved',
    );
  });

  it('names the codes in baseline-then-compared order', () => {
    // Mirror of the case above. A reason that always printed "0 vs 1" would pass
    // that one while telling the reader the wrong side had the findings.
    const verdict = verdictFor(perfRow({ exitCode: 1 }), perfRow());

    expect(reasonOf(verdict)).toContain('accepted exit codes differ (1 vs 0)');
  });
});

describe('comparePerf — the exit-code check does not displace its neighbours', () => {
  it('names the FAILURE, not an exit-code difference, when the baseline failed', () => {
    // A failed row carries `exitCode: null` by design, so an exit-code check
    // that ran before the failure checks would report "(null vs 0)" here — a
    // true statement about the wrong thing, sending the reader to look for a
    // finding-count change instead of a crash.
    const crashed = perfRow({
      failed: true,
      failure: '3 of 3 repeats failed — exited 2: config not found',
      exitCode: null,
      samplesMs: [],
      medianMs: 0,
      minMs: 0,
      maxMs: 0,
      iqrMs: 0,
    });

    const verdict = verdictFor(crashed, perfRow());

    expect(verdict.kind).toBe('unmeasurable');
    expect(reasonOf(verdict)).toContain('baseline failed: 3 of 3 repeats failed');
    expect(reasonOf(verdict)).not.toContain('exit codes differ');
  });

  it('still reports a cache-mode mismatch between two rows that agree on their code', () => {
    const verdict = verdictFor(perfRow(), perfRow({ cache: 'cold' }));

    expect(verdict.kind).toBe('unmeasurable');
    expect(reasonOf(verdict)).toContain('cache mode differs (warm vs cold)');
  });

  it('names the cache mismatch first when a pair trips both checks', () => {
    // Both are true of this pair. The cache mode is the operator's own knob and
    // is fixed by re-running; the exit code sends the reader off to investigate
    // the subject. Pinned because the choice is deliberate, not incidental.
    const verdict = verdictFor(perfRow(), perfRow({ cache: 'cold', exitCode: 1 }));

    expect(reasonOf(verdict)).toContain('cache mode differs');
    expect(reasonOf(verdict)).not.toContain('exit codes differ');
  });
});
