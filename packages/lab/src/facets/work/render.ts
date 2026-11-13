/**
 * Rendering `work` reports and comparisons for a terminal.
 *
 * Every counter prints, zeros included: the shape of the work is what a reader
 * is here for, and a counter left out would be indistinguishable from one the
 * measured vat does not emit. A reported-only counter says so on its own line,
 * so it is never read as an exact finding.
 */

import type { ReportEnvelope } from '../../envelope/envelope.js';
import {
  countMovement,
  type LoadPhrasing,
  movementMark,
  noMeasurementLines,
  oneSidedLines,
  renderFacetComparison,
  renderFacetReport,
  tally,
} from '../../harness/render.js';

import type { WorkComparisonResult, WorkCounterMovement, WorkMovement } from './compare.js';
import { comparedExactly, type WorkBody, type WorkCommandStats } from './types.js';

/** What the numbers are. */
const COUNTING_LEGEND =
  "Counted: vat's own work counters, summed across the reported repeat's processes " +
  '(store rows decoded and written, extents derived and served, parses dispatched, content hashed, git calls).';

/** Appended to a counter that is reported but never compared exactly. */
const REPORTED_ONLY_NOTE = '  (reported only — not deterministic, never compared exactly)';

/** How a busy machine qualifies these numbers. */
const LOAD_PHRASING: LoadPhrasing = {
  unmeasured: 'the load-dependent counter (parse.refused.load) carries no contamination check.',
  contaminated: 'exact counters stand, but parse.refused.load moves with load.',
};

/** Said when either side of a comparison ran on a busy machine. */
const CONTAMINATION_NOTE =
  '⚠ At least one side was captured on a contaminated machine. Exact counters do not move with ' +
  'load unless a parse was refused under it, and a row with such a refusal withholds its verdict.';

/**
 * The stability sentence for a measured row.
 *
 * @param row - The row
 * @returns One indented line
 */
function stabilityLine(row: WorkCommandStats): string {
  if (row.stable === true) {
    return '      repeats agreed on every exact counter — an exact delta against another report is warranted.';
  }
  if (row.stable === false) {
    const exact = row.varied.filter((name) => comparedExactly(name, row.cache));
    return `      ⚠ UNSTABLE — the compared repeats disagreed on ${exact.join(', ')}, so a delta against another report has no warrant.`;
  }
  if (row.loadRefusedRepeats > 0) {
    return (
      `      ⚠ LOAD REFUSALS — a parse was refused under machine load in ${tally(row.loadRefusedRepeats)} of ` +
      `${tally(row.runs)} repeats, which moves the counters downstream of it, so a delta has no warrant.`
    );
  }
  return `      ⚠ DETERMINISM UNTESTED — only ${tally(row.comparedRuns)} compared repeats, so nothing could have disagreed.`;
}

/**
 * Every line for one command of a report.
 *
 * @param row - The command's row
 * @returns Its block
 */
function commandLines(row: WorkCommandStats): readonly string[] {
  if (row.failed) return [`  ${row.name}: FAILED — ${row.failure ?? 'unknown'}`];
  return [
    `  ${row.name} (${row.cache}, ${tally(row.runs)} runs, ${tally(row.comparedRuns)} compared, ` +
      `${tally(row.processes)} processes):`,
    stabilityLine(row),
    ...row.counters.map(
      (reading) =>
        `      ${reading.name}  ${tally(reading.count)}${comparedExactly(reading.name, row.cache) ? '' : REPORTED_ONLY_NOTE}`,
    ),
  ];
}

/**
 * Render a captured `work` report.
 *
 * @param report - The report
 * @returns Text for a terminal
 */
export function renderWorkReport(report: ReportEnvelope<WorkBody>): string {
  return renderFacetReport(report, LOAD_PHRASING, COUNTING_LEGEND, commandLines);
}

/**
 * One counter's movement line.
 *
 * @param movement - The counter's movement
 * @returns One indented line
 */
function counterLine(movement: WorkCounterMovement): string {
  const { marker } = movementMark(movement.kind, movement.exact);
  return `      ${marker} ${countMovement(movement.name, movement.count)}${movement.exact ? '' : REPORTED_ONLY_NOTE}`;
}

/**
 * One line per counter that moved.
 *
 * @param movement - One command's movement
 * @returns Its lines
 */
function movementLines(movement: WorkMovement): readonly string[] {
  return movement.counters.map((counter) => counterLine(counter));
}

/**
 * Every line for one command's diff.
 *
 * @param diff - The command's diff
 * @returns Its block
 */
function diffLines(diff: WorkComparisonResult['commands'][number]): readonly string[] {
  const verdict = diff.verdict;
  switch (verdict.kind) {
    case 'changed': {
      return [`  ${diff.name}: CHANGED`, ...movementLines(verdict.movement)];
    }
    case 'unchanged': {
      return [`  ${diff.name}: unchanged — every exact counter identical`, ...movementLines(verdict.movement)];
    }
    case 'unwarranted': {
      return [
        `  ${diff.name}: NOT ATTRIBUTABLE — ${verdict.reason}`,
        '      the movement below is real, but it cannot be read as a difference in the subject:',
        ...movementLines(verdict.movement),
      ];
    }
    case 'unmeasurable': {
      return noMeasurementLines(diff.name, verdict.reason);
    }
    case 'added':
    case 'removed': {
      return oneSidedLines(diff.name, verdict.kind);
    }
  }
}

/**
 * Render a `work` comparison.
 *
 * @param comparison - A completed comparison
 * @returns Text for a terminal
 */
export function renderWorkComparison(comparison: WorkComparisonResult): string {
  return renderFacetComparison(comparison, COUNTING_LEGEND, CONTAMINATION_NOTE, diffLines);
}
