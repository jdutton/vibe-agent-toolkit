/**
 * Human-readable rendering of `perf` reports and comparisons.
 *
 * Rendering is where an honest measurement most easily becomes a dishonest
 * claim, so two rules hold throughout:
 *
 * - **Every number appears with what qualifies it.** A median is never shown
 *   without its spread, and a contaminated capture says so at the top rather
 *   than in a footnote nobody reads.
 * - **The absence of a delta is never rendered as good news.** `unmeasurable`
 *   and `below-resolution` get their own words, because a reader scanning for
 *   green will otherwise count them as passes.
 */

import type { ReportEnvelope } from '../../envelope/envelope.js';

import type { PerfComparisonResult } from './compare.js';
import type { PerfBody, PerfCommandStats } from './types.js';

/** Decimal places used for millisecond values. */
const MS_PRECISION = 1;

/**
 * Format a millisecond value.
 *
 * @param value - Milliseconds
 * @returns A fixed-precision rendering
 */
function ms(value: number): string {
  return `${value.toFixed(MS_PRECISION)}ms`;
}

/**
 * One line describing a measured command.
 *
 * @param row - The command's statistics
 * @returns A single line
 */
function rowLine(row: PerfCommandStats): string {
  if (row.failed) {
    return `  ${row.name}: FAILED — ${row.failure ?? 'unknown'}`;
  }
  return (
    `  ${row.name}: ${ms(row.medianMs)} median ` +
    `(±${ms(row.iqrMs)} IQR, ${ms(row.minMs)}–${ms(row.maxMs)}, ${String(row.runs)} runs, ${row.cache})`
  );
}

/**
 * Describe how much the machine load qualifies a report's numbers.
 *
 * @param body - The report body
 * @returns A single line
 */
function loadLine(body: PerfBody): string {
  if (!body.load.available) {
    return 'Machine load: NOT MEASURED on this platform — these timings carry no contamination check.';
  }
  if (body.load.contaminated) {
    return `Machine load: CONTAMINATED (${String(body.load.before)} → ${String(body.load.after)} over ${String(body.load.cpus)} CPUs) — treat these timings as indicative only.`;
  }
  return `Machine load: clean (${String(body.load.before)} → ${String(body.load.after)} over ${String(body.load.cpus)} CPUs).`;
}

/**
 * Render a captured report.
 *
 * @param report - The report to render
 * @returns Text for a terminal
 */
export function renderPerfReport(report: ReportEnvelope<PerfBody>): string {
  const { subject, subjectVersion, instrument } = report.coordinate;
  let versionLine: string;
  if (subjectVersion.kind === 'git') {
    // A dirty tree is measurable but says so — the bytes measured were not the
    // bytes at that commit, and a reader comparing later must know that.
    const dirty = subjectVersion.dirty ? ' (DIRTY working tree)' : '';
    versionLine = `${subjectVersion.commit.slice(0, 8)}${dirty}`;
  } else {
    versionLine = `snapshot ${subjectVersion.fingerprint.slice(0, 8)} (${String(subjectVersion.fileCount)} files)`;
  }
  const build = instrument.commit === null ? 'released' : instrument.commit.slice(0, 8);

  return [
    `Subject:    ${subject.id} @ ${versionLine}`,
    `Instrument: vat ${instrument.version} (${build})`,
    loadLine(report.body),
    '',
    ...report.body.commands.map((row) => rowLine(row)),
  ].join('\n');
}

/**
 * One line describing what happened to a command between two reports.
 *
 * @param diff - The command's diff row
 * @returns A single line
 */
function verdictLine(diff: PerfComparisonResult['commands'][number]): string {
  const verdict = diff.verdict;
  switch (verdict.kind) {
    case 'changed': {
      const direction = verdict.significance.deltaMs < 0 ? 'FASTER' : 'SLOWER';
      return `  ${diff.name}: ${direction} by ${ms(Math.abs(verdict.significance.deltaMs))}`;
    }
    case 'unchanged': {
      return `  ${diff.name}: unchanged (${ms(Math.abs(verdict.significance.deltaMs))} is within noise)`;
    }
    case 'below-resolution': {
      return `  ${diff.name}: NOT MEASURABLE at this scale — both sides are under the ${ms(verdict.floorMs)} floor, so no change could ever be reported here`;
    }
    case 'unmeasurable': {
      return `  ${diff.name}: NO MEASUREMENT — ${verdict.reason}`;
    }
    case 'added': {
      return `  ${diff.name}: new, no baseline to compare against`;
    }
    case 'removed': {
      return `  ${diff.name}: gone, present only in the baseline`;
    }
  }
}

/**
 * Render a comparison.
 *
 * @param comparison - A completed comparison
 * @returns Text for a terminal
 */
export function renderPerfComparison(comparison: PerfComparisonResult): string {
  const heading =
    comparison.axis === null
      ? 'Comparing two reports at the same coordinate'
      : `Comparing along one axis: ${comparison.axis}`;
  const warning = comparison.contaminated
    ? '\n⚠  At least one side was captured on a contaminated machine. Every delta below is suspect.'
    : '';
  return [heading + warning, '', ...comparison.commands.map((diff) => verdictLine(diff))].join('\n');
}
