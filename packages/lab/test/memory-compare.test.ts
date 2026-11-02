/**
 * `compareMemory` and its renderer: a moved peak is reported as moved, a
 * jitter-sized one is not, and a pair that measured different things yields no
 * delta at all.
 *
 * The fixture sizes are the ones the facet was built to see: an adopter's
 * `vat build` at ~1.0 GiB on one build and ~5.4 GiB on the next.
 */

import { describe, expect, it } from 'vitest';

import type { ReportEnvelope } from '../src/envelope/envelope.js';
import { compareMemory, type MemoryComparisonResult } from '../src/facets/memory/compare.js';
import { renderMemoryComparison, renderMemoryReport } from '../src/facets/memory/render.js';
import { MEMORY_FACET, type MemoryBody, type MemoryCommandStats } from '../src/facets/memory/types.js';

import { CLEAN_LOAD, makeReport, makeReportAt } from './report-fixtures.js';

/** Kilobytes in a gibibyte. */
const GIB_KB = 1024 * 1024;

/**
 * One successful row at a given median peak, with a tight spread around it.
 *
 * @param medianKb - The median peak
 * @param over - What a case varies
 * @returns The row
 */
function row(medianKb: number, over: Partial<MemoryCommandStats> = {}): MemoryCommandStats {
  return {
    name: 'build',
    args: ['build'],
    cache: 'warm',
    runs: 3,
    medianKb,
    minKb: medianKb - 1024,
    maxKb: medianKb + 1024,
    iqrKb: 1024,
    samplesKb: [medianKb - 1024, medianKb, medianKb + 1024],
    processesPerRepeat: [1, 1, 1],
    exitCode: 0,
    failed: false,
    failure: null,
    ...over,
  };
}

/**
 * A memory report carrying one row.
 *
 * @param command - The row
 * @param base - The envelope to put it in; defaults to the shared coordinate
 * @returns The report
 */
function reportWith(command: MemoryCommandStats, base: ReportEnvelope<unknown> = makeReport()): ReportEnvelope<MemoryBody> {
  return { ...base, facet: MEMORY_FACET, body: { commands: [command], load: CLEAN_LOAD } };
}

/**
 * Compare a baseline row against a compared one, along the instrument axis.
 *
 * @param before - Baseline row
 * @param after - Compared row
 * @returns The completed comparison
 */
function compared(before: MemoryCommandStats, after: MemoryCommandStats): MemoryComparisonResult {
  const later = makeReportAt({ instrument: { version: '0.1.43', commit: '2'.repeat(40), dirty: false, closure: null } });
  const result = compareMemory(reportWith(before), reportWith(after, later));
  if (!result.ok) throw new Error(result.refusal);
  return result;
}

/**
 * The one command's verdict.
 *
 * @param comparison - A one-command comparison
 * @returns Its verdict
 */
function onlyVerdict(comparison: MemoryComparisonResult): MemoryComparisonResult['commands'][number]['verdict'] {
  const [diff] = comparison.commands;
  if (diff === undefined) throw new Error('no command in the comparison');
  return diff.verdict;
}

describe('compareMemory', () => {
  it('reports a 1.0 GiB -> 5.4 GiB peak as CHANGED, with the ratio', () => {
    const comparison = compared(row(GIB_KB), row(5.4 * GIB_KB));
    const verdict = onlyVerdict(comparison);

    expect(verdict.kind).toBe('changed');
    if (verdict.kind !== 'changed') return;
    expect(verdict.peak.delta).toBeCloseTo(4.4 * GIB_KB);
    expect(verdict.peak.ratio).toBeCloseTo(5.4);
    expect(comparison.axis).toBe('instrument');
  });

  it('calls a 5% move unchanged — it is under the 10% relative gate', () => {
    expect(onlyVerdict(compared(row(GIB_KB), row(1.05 * GIB_KB))).kind).toBe('unchanged');
  });

  it('calls a 6 MiB move on a small peak unchanged — it is under the 8 MiB floor', () => {
    // 6 MiB on 40 MiB is 15%, past the relative gate and the arms' 4 MiB spread: only the floor stops it.
    expect(onlyVerdict(compared(row(40 * 1024), row(46 * 1024))).kind).toBe('unchanged');
  });

  it('calls a 10 MiB move on a small peak CHANGED — over the floor, the 10% gate and the spread', () => {
    expect(onlyVerdict(compared(row(40 * 1024), row(50 * 1024))).kind).toBe('changed');
  });

  it('calls a move inside the arms\' combined spread unchanged, though it clears both gates', () => {
    // 200 MiB on 1 GiB clears 10% and 8 MiB; each arm's repeats spanned 300 MiB.
    const wide = { minKb: GIB_KB - 150 * 1024, maxKb: GIB_KB + 150 * 1024 };
    const after = 1.2 * GIB_KB;
    const verdict = onlyVerdict(compared(row(GIB_KB, wide), row(after, { minKb: after - 150 * 1024, maxKb: after + 150 * 1024 })));

    expect(verdict.kind).toBe('unchanged');
  });

  it('calls a different count of vat processes CHANGED, even at the same peak', () => {
    const verdict = onlyVerdict(compared(row(GIB_KB), row(GIB_KB, { processesPerRepeat: [2, 2, 2] })));

    expect(verdict.kind).toBe('changed');
    if (verdict.kind !== 'changed') return;
    expect(verdict.processes).toEqual({ before: 1, after: 2 });
  });

  it('does not call a different process count CHANGED across instrument kinds, and says why', () => {
    // An npx arm launches through a published package's own `bin`; a tree arm runs `dist/bin.js`.
    const npx = makeReportAt({ instrument: { version: '0.1.43', commit: null, dirty: null, closure: null } });
    const result = compareMemory(reportWith(row(GIB_KB)), reportWith(row(GIB_KB, { processesPerRepeat: [2, 2, 2] }), npx));
    if (!result.ok) throw new Error(result.refusal);
    const [diff] = result.commands;

    expect(diff?.verdict.kind).toBe('unchanged');
    expect(diff?.caveat).toContain('instrument kinds differ (tree vs npx)');
    expect(renderMemoryComparison(result)).toContain('instrument kinds differ (tree vs npx)');
  });

  it('yields no delta when a side failed, and names the side', () => {
    const failed = row(0, { failed: true, failure: 'no RSS dumps', minKb: 0, maxKb: 0, iqrKb: 0, samplesKb: [], exitCode: null });
    const verdict = onlyVerdict(compared(row(GIB_KB), failed));

    expect(verdict).toEqual({ kind: 'unmeasurable', reason: expect.stringContaining('compared side row failed: no RSS dumps') });
  });

  it('yields no delta when the accepted exits differ', () => {
    const verdict = onlyVerdict(compared(row(GIB_KB), row(5.4 * GIB_KB, { exitCode: 1 })));

    expect(verdict).toEqual({ kind: 'unmeasurable', reason: expect.stringContaining('accepted exit codes differ (0 vs 1)') });
  });

  it('refuses a body that is not the memory shape', () => {
    const malformed = { ...makeReport(), facet: MEMORY_FACET, body: { commands: [{ name: 'build' }], load: CLEAN_LOAD } };
    const result = compareMemory(reportWith(row(GIB_KB)), malformed);

    expect(result.ok).toBe(false);
  });
});

describe('the memory renderers', () => {
  it('prints the median, the spread, the process count and the worker-thread legend', () => {
    const text = renderMemoryReport(reportWith(row(GIB_KB, { processesPerRepeat: [2, 2, 2] })));

    expect(text).toContain('build: 1.00 GiB median peak RSS');
    expect(text).toContain('2 vat processes)');
    expect(text).toContain('worker threads INCLUDED');
    expect(text).toContain('the parent\'s memory EXCLUDED');
  });

  it('says FAILED, never a zero peak, for a failed row', () => {
    const text = renderMemoryReport(reportWith(row(0, { failed: true, failure: 'killed', minKb: 0, maxKb: 0, exitCode: null })));

    expect(text).toContain('build: FAILED — killed');
    expect(text).not.toContain('0.0 MiB');
  });

  it('prints both peaks and the factor on a changed comparison', () => {
    const text = renderMemoryComparison(compared(row(GIB_KB), row(5.4 * GIB_KB)));

    expect(text).toContain('build: CHANGED — median peak RSS 1.00 GiB -> 5.40 GiB (×5.40), 1 vat processes');
  });

  it('prints a moved process count on the comparison', () => {
    const text = renderMemoryComparison(compared(row(GIB_KB), row(GIB_KB, { processesPerRepeat: [2, 2, 2] })));

    expect(text).toContain('vat processes 1 -> 2');
  });
});
