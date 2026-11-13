/**
 * Rendering `work` reports and comparisons: the sentences a reader must not be
 * able to misread — a failed row as zero work, a reported-only counter as an
 * exact finding, an unstable row as a warranted delta.
 */

import { describe, expect, it } from 'vitest';

import type { ReportEnvelope } from '../src/envelope/envelope.js';
import { compareWork } from '../src/facets/work/compare.js';
import { renderWorkComparison, renderWorkReport } from '../src/facets/work/render.js';
import { WORK_FACET, type WorkBody, type WorkCommandStats } from '../src/facets/work/types.js';

import { CLEAN_LOAD, makeReport } from './report-fixtures.js';
import { workCounters as counters, workRow } from './work-fixtures.js';

/** A measured row of two processes, one of whose counters is reported only. */
function row(over: Partial<WorkCommandStats> = {}): WorkCommandStats {
  return workRow({
    processes: 2,
    counters: counters({ 'store.rows.decoded.persistent': 1200, 'parse.refused.load': 1 }),
    ...over,
  });
}

/** A report of these rows. */
function report(commands: readonly WorkCommandStats[]): ReportEnvelope<WorkBody> {
  return makeReport({ facet: WORK_FACET, body: { commands, load: CLEAN_LOAD } }) as ReportEnvelope<WorkBody>;
}

describe('renderWorkReport', () => {
  it('prints every counter with its count, and marks the reported-only one', () => {
    const text = renderWorkReport(report([row()]));
    expect(text).toContain('store.rows.decoded.persistent  1,200');
    expect(text).toMatch(/parse\.refused\.load {2}1 {2}\(reported only/);
    expect(text).toContain('repeats agreed');
  });

  it('names the counters an unstable row disagreed on', () => {
    const text = renderWorkReport(report([row({ stable: false, varied: ['git.calls'] })]));
    expect(text).toMatch(/UNSTABLE.*git\.calls/);
  });

  it('names load refusals as why a row has no warrant', () => {
    const text = renderWorkReport(report([row({ stable: null, loadRefusedRepeats: 2 })]));
    expect(text).toMatch(/LOAD REFUSALS.*2 of 2 compared repeats/);
  });

  it('prints a failed row as a failure, never as zeros', () => {
    const text = renderWorkReport(report([row({ failed: true, failure: 'REFUSED: no cli dump', counters: [] })]));
    expect(text).toContain("resources-scan: FAILED — REFUSED: no cli dump");
    expect(text).not.toContain('store.rows.decoded.persistent');
  });
});

describe('renderWorkComparison', () => {
  it('prints a changed counter with its exact delta', () => {
    const result = compareWork(
      report([row()]),
      report([row({ counters: counters({ 'store.rows.decoded.persistent': 1201, 'parse.refused.load': 1 }) })]),
    );
    if (!result.ok) throw new Error(result.refusal);
    const text = renderWorkComparison(result);
    expect(text).toContain('resources-scan: CHANGED');
    expect(text).toContain('~ store.rows.decoded.persistent 1,200 -> 1,201 (+1)');
  });

  it('prints a moved reported-only counter without calling it a change', () => {
    const result = compareWork(
      report([row()]),
      report([row({ counters: counters({ 'store.rows.decoded.persistent': 1200, 'parse.refused.load': 4 }) })]),
    );
    if (!result.ok) throw new Error(result.refusal);
    const text = renderWorkComparison(result);
    expect(text).toContain('resources-scan: unchanged');
    expect(text).toMatch(/parse\.refused\.load 1 -> 4 \(\+3\) {2}\(reported only/);
  });
});
