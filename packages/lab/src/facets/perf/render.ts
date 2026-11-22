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
import { coordinateLines } from '../../harness/render.js';

import type { PerfComparisonResult } from './compare.js';
import type { GateDeclinedBy, PerfBody, PerfCommandStats, PerfStats } from './types.js';

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
  // A completed run that exited non-zero says so. A gate completes with its
  // findings exit too (see `MeasuredCommandSpec.exit`),
  // and two rows with the same median where one exited 0 and one exited 1 are
  // not the same measurement — the second one also rendered its findings.
  const exit = row.exitCode === 0 || row.exitCode === null ? '' : `, exit ${String(row.exitCode)}`;
  return (
    `  ${row.name}: ${ms(row.medianMs)} median ` +
    `(±${ms(row.iqrMs)} IQR, ${ms(row.minMs)}–${ms(row.maxMs)}, ${String(row.runs)} runs, ${row.cache}${exit})`
  );
}

/**
 * A statistic with its spread, in the one spelling every figure here uses.
 *
 * @param stats - Median, spread and range
 * @returns `12.3ms median (+-1.0ms IQR, 11.0ms-14.0ms)`
 */
function spread(stats: PerfStats): string {
  return `${ms(stats.medianMs)} median (±${ms(stats.iqrMs)} IQR, ${ms(stats.minMs)}-${ms(stats.maxMs)})`;
}

/**
 * Name what declined the overlap, as the build said it.
 *
 * @param declined - The build's answer, or `null` when it named nothing
 * @returns A phrase
 */
function declinedBy(declined: GateDeclinedBy | null): string {
  if (declined === null) return 'a condition the build did not name';
  if (declined.condition === 'member') return `member (member ${declined.member}, route ${declined.route})`;
  if (declined.condition === 'rejected') return `rejected (error: ${declined.error})`;
  return declined.condition;
}

/**
 * The lines under a row: CPU over processes, each surface's wall, and whether the checks child overlapped.
 *
 * @param row - A row that completed
 * @returns Indented lines
 */
function probeLines(row: PerfCommandStats): string[] {
  const cpu =
    row.cpuMs === null
      ? '    CPU: NOT MEASURED (no vat process wrote a record): unknown, not zero'
      : `    CPU: ${spread(row.cpuMs)}, summed over ${String(row.processes[0]?.length ?? 0)} vat process(es); wall is never summed`;
  const surfaces = Object.entries(row.surfaces).map(([name, stats]) => `    surface ${name}: ${spread(stats)}`);
  let overlap = '    checks child: unknown (this build wrote no debug facts; that is not "did not overlap")';
  if (row.checksOverlapped === 1) overlap = '    checks child: overlapped';
  if (row.checksOverlapped === 0) overlap = `    checks child: NOT overlapped, declined by ${declinedBy(row.gateDeclinedBy)}`;
  return [cpu, ...surfaces, overlap];
}

/**
 * One line per command whose gate declined, ahead of every wall figure: a run
 * that did not overlap measures something else, so no timing below it is read as
 * the overlap's.
 *
 * @param body - The report body
 * @returns The lines, none when every gate fired or is unknown
 */
function gateLines(body: PerfBody): string[] {
  return body.commands
    .filter((row) => row.checksOverlapped === 0)
    .map((row) => `GATE DID NOT FIRE: ${row.name} (${row.cache}) ran its checks child sequentially, declined by ${declinedBy(row.gateDeclinedBy)}.`);
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
  return [
    // The shared header, not a third hand-written copy of it. This one used to
    // be its own, and so was the only renderer that would not have picked up the
    // instrument's DIRTY label when axis C finally acquired one.
    ...coordinateLines(report.coordinate),
    loadLine(report.body),
    ...gateLines(report.body),
    '',
    ...report.body.commands.flatMap((row) => (row.failed ? [rowLine(row)] : [rowLine(row), ...probeLines(row)])),
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
