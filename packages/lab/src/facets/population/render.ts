/**
 * Human-readable rendering of `population` reports and comparisons.
 *
 * Two rules, both of which this facet can break in ways the others cannot:
 *
 * - **Every set appears with what qualifies it.** A count is never shown without
 *   the lane that produced it and whether the repeats agreed. A population whose
 *   lane is unknown is a population whose arm is unproven, and that has to be
 *   visible in the line, not inferable from the absence of one.
 * - **A truncated list says how much it dropped, in the same line.** These lists
 *   run to thousands of paths on a real corpus, so they are capped — but a cap
 *   nobody is told about renders a wholesale divergence as a handful of files.
 */

import type { ReportEnvelope } from '../../envelope/envelope.js';
import { coordinateLines } from '../../harness/render.js';

import type { PopulationComparisonResult } from './compare.js';
import type { PopulationBody, PopulationCommandStats } from './types.js';

/**
 * How many paths of any one list are printed before the rest are counted.
 *
 * Enough to recognise a pattern in the divergence, few enough that a comparison
 * of two whole corpora stays readable. The remainder is always stated; the full
 * lists are in the stored report, which is the artifact anyone acting on this
 * will read.
 */
const PATH_SAMPLE_LIMIT = 10;

/**
 * Render a list of paths, capped, saying how many were not shown.
 *
 * @param label - What the list is
 * @param paths - The paths
 * @returns Indented lines, or none when the list is empty
 */
function pathLines(label: string, paths: readonly string[]): string[] {
  if (paths.length === 0) return [];
  const shown = paths.slice(0, PATH_SAMPLE_LIMIT);
  const remainder = paths.length - shown.length;
  const tail =
    remainder === 0 ? [] : [`      … and ${String(remainder)} more (the report has all of them)`];
  return [
    `    ${label} (${String(paths.length)}):`,
    ...shown.map((path) => `      ${path}`),
    ...tail,
  ];
}

/**
 * How a row's lane reads.
 *
 * A missing lane is spelled out rather than left blank: it means the measured
 * build does not report which enumerator ran, so the row cannot prove it is the
 * arm the caller intended.
 *
 * @param row - The command's row
 * @returns A phrase for the row line
 */
function laneOf(row: PopulationCommandStats): string {
  return row.lane ?? 'lane UNREPORTED by this build';
}

/**
 * How a row's stability reads.
 *
 * @param row - The command's row
 * @returns A phrase for the row line
 */
function stabilityOf(row: PopulationCommandStats): string {
  if (row.stable === null) return 'single repeat, nothing could disagree';
  return row.stable ? 'repeats agreed' : 'REPEATS DISAGREED';
}

/**
 * How a row's git reference reads.
 *
 * @param row - The command's row
 * @returns A phrase for the row line
 */
function referenceOf(row: PopulationCommandStats): string {
  if (row.gitTracked === null) return 'no git reference at this root';
  return `${String(row.offGit.length)} off-git of ${String(row.gitTracked)} tracked`;
}

/**
 * One line describing a measured command, plus its off-git sample.
 *
 * @param row - The command's statistics
 * @returns Lines
 */
function rowLines(row: PopulationCommandStats): string[] {
  if (row.failed) return [`  ${row.name}: NO POPULATION — ${row.failure ?? 'unknown'}`];
  const head =
    `  ${row.name}: ${String(row.count)} files ` +
    `(${laneOf(row)}, ${String(row.runs)} runs, ${stabilityOf(row)}, ${referenceOf(row)})`;
  return [head, ...pathLines('off-git', row.offGit)];
}

/**
 * Describe how much the machine load qualifies a report.
 *
 * @param body - The report body
 * @returns A single line
 */
function loadLine(body: PopulationBody): string {
  if (!body.load.available) {
    return 'Machine load: NOT MEASURED on this platform.';
  }
  if (body.load.contaminated) {
    // Deliberately weaker wording than the timing facets use. A busy machine
    // does not change which files exist, so this qualifies the run rather than
    // the result — saying "treat these as indicative only" would teach a reader
    // to discount a set difference that is exactly as real as it looks.
    return `Machine load: busy (${String(body.load.before)} → ${String(body.load.after)} over ${String(body.load.cpus)} CPUs) — a set is not distorted by load, but the run competed for the disk.`;
  }
  return `Machine load: clean (${String(body.load.before)} → ${String(body.load.after)} over ${String(body.load.cpus)} CPUs).`;
}

/**
 * Render a captured report.
 *
 * @param report - The report to render
 * @returns Text for a terminal
 */
export function renderPopulationReport(report: ReportEnvelope<PopulationBody>): string {
  return [
    ...coordinateLines(report.coordinate),
    loadLine(report.body),
    '',
    ...report.body.commands.flatMap((row) => rowLines(row)),
  ].join('\n');
}

/**
 * The lane caveat for one command's pair of rows.
 *
 * Two sides that report the SAME lane are two runs of one enumerator, and their
 * agreement means nothing about the question a lane comparison was asked. That
 * is the failure this facet was built to make visible, so it is said on the row
 * rather than left to a reader holding two reports open.
 *
 * @param diff - The command's diff row
 * @returns A clause to append, or an empty string
 */
function laneNote(diff: PopulationComparisonResult['commands'][number]): string {
  const before = diff.before?.lane ?? null;
  const after = diff.after?.lane ?? null;
  if (before === null || after === null) return '';
  if (before !== after) return ` [${before} → ${after}]`;
  return ` [both sides ran the '${before}' lane — this compares one enumerator with itself]`;
}

/**
 * Lines describing what happened to a command between two reports.
 *
 * @param diff - The command's diff row
 * @returns Lines
 */
function verdictLines(diff: PopulationComparisonResult['commands'][number]): string[] {
  const verdict = diff.verdict;
  switch (verdict.kind) {
    case 'changed': {
      const head =
        `  ${diff.name}: CHANGED — ` +
        `+${String(verdict.added.length)} / −${String(verdict.removed.length)} / ` +
        `~${String(verdict.changed.length)} content${laneNote(diff)}`;
      return [
        head,
        ...pathLines('only in compared', verdict.added),
        ...pathLines('only in baseline', verdict.removed),
        ...pathLines('same path, different content', verdict.changed),
      ];
    }
    case 'unchanged': {
      const count = diff.after?.count ?? 0;
      return [
        `  ${diff.name}: unchanged — the same ${String(count)} files, same content${laneNote(diff)}`,
      ];
    }
    case 'unmeasurable': {
      return [`  ${diff.name}: NO COMPARISON — ${verdict.reason}`];
    }
    case 'added': {
      return [`  ${diff.name}: new, no baseline to compare against`];
    }
    case 'removed': {
      return [`  ${diff.name}: gone, present only in the baseline`];
    }
  }
}

/**
 * Render a comparison.
 *
 * @param comparison - A completed comparison
 * @returns Text for a terminal
 */
export function renderPopulationComparison(comparison: PopulationComparisonResult): string {
  const heading =
    comparison.axis === null
      ? 'Comparing two reports at the same coordinate'
      : `Comparing along one axis: ${comparison.axis}`;
  return [heading, '', ...comparison.commands.flatMap((diff) => verdictLines(diff))].join('\n');
}
