/**
 * Human-readable rendering of `io` reports and comparisons.
 *
 * Rendering is where an honest measurement most easily becomes a dishonest
 * claim. Three rules hold throughout, and each of them has a specific failure it
 * exists to prevent:
 *
 * - **Every number appears with what qualifies it.** {@link IoCommandStats.loaderCalls}
 *   is never hidden: on `vat resources scan docs/`, 6,371 of 6,411 calls came
 *   from Node's own ESM loader resolving and reading modules. The facet buckets
 *   those out of the site list so vat's own 40 calls are visible at all — but a
 *   report that then showed only the remainder would let a reader conclude "vat
 *   barely touches the disk", and "6,371 were bucketed out" versus "there were
 *   only 40" support opposite conclusions. {@link IoCommandStats.processes} is
 *   the same hazard in reverse: it is printed even when it is 1, because 1 means
 *   the counter never propagated into vat's real binary and every other number
 *   on the line describes the launcher alone. {@link IoCommandStats.stable} is
 *   printed next to the counts it qualifies, not in a footnote.
 * - **The absence of a delta is never rendered as good news.** `unmeasurable`
 *   and `unwarranted` get their own words, because a reader scanning for green
 *   will otherwise count a broken or unattributable command as a pass.
 * - **These are Node `fs` and `child_process` calls, never syscalls.** One
 *   `fs.readFile` is one call into Node's library, whatever number of kernel
 *   operations it turns into. A reader who took the other label literally would
 *   compare these numbers against `dtruss` output and never reconcile them, so
 *   the word does not appear in any string this module produces.
 *
 * The N+1 finding is the whole point of the facet, so `count` and `distinctArgs`
 * are always shown together and never separately: `28 calls / 14 distinct args`
 * is 14 directories read exactly twice each (a real finding, in
 * `claude-marketplace/dist/inventory/extract-plugin.js:321`), while
 * `436 calls / 436 distinct args` is necessary work. A bare count cannot tell
 * those apart. A capped site is rendered as a floor rather than an exact number,
 * because reading a floor as exact would report an N+1 that may not exist.
 *
 * A site with NO reading (`distinctArgs: null` — a spawn, a two-path `fs`
 * operation, `mkdtemp`) gets neither a number nor a ratio, and says which it is.
 * That row used to render as `8 calls / 1 distinct args  >=8.0x repeated`, sitting
 * beside genuine redundancy rows and structurally guaranteed to look that way for
 * every spawn site — the most convincing wrong finding this renderer has produced.
 */

import type { ReportEnvelope } from '../../envelope/envelope.js';
import {
  comparisonText,
  coordinateLines,
  type LoadPhrasing,
  loadLine,
  noMeasurementLines,
  oneSidedLines,
  tally,
} from '../../harness/render.js';

import type { IoComparisonResult, IoCountDelta, IoMovement, IoSiteMovement } from './compare.js';
import type { IoBody, IoCommandStats, IoSite } from './types.js';

/** Decimal places used for a repetition ratio. */
const RATIO_PRECISION = 1;

/**
 * How many call sites a report shows per command before it truncates.
 *
 * Truncation is safe only because the aggregates are printed above the list: the
 * user total already includes every withheld site, so a shortened list can hide
 * detail but never volume.
 */
const DEFAULT_MAX_SITES = 12;

/**
 * The label that keeps a reader from comparing these numbers against `dtruss`.
 *
 * Printed on both the report and the comparison, because either can be pasted
 * somewhere on its own.
 */
const COUNTING_LEGEND =
  'Counted: Node fs and child_process calls. One fs.readFile is one call into ' +
  "Node's library, whatever the kernel then does with it.";

/** Said when only one process was counted. See {@link IoCommandStats.processes}. */
const PROPAGATION_WARNING =
  '      ⚠ COUNTER DID NOT PROPAGATE — only one process was counted, so these numbers ' +
  "describe vat's launcher rather than the command it spawned.";

/**
 * Said where a distinct-argument count would otherwise go.
 *
 * Not `0 distinct args`, which is a real and different measurement (fd-based
 * work, where a reading WAS taken and no call carried a path).
 */
const NO_READING_NOTE =
  'distinct args NOT TRACKED (the first argument does not identify the work here — ' +
  'a spawn names the binary, not the command it ran)';

/** Said at the top of a comparison when either capture was contaminated. */
const CONTAMINATION_NOTE =
  '⚠ At least one side was captured on a contaminated machine. Call counts do not move with ' +
  'machine load, so the deltas below still stand — but the run was competing for the filesystem, ' +
  'and any perf report from the same session is suspect.';

/**
 * Render a difference with its sign.
 *
 * @param delta - The signed difference
 * @returns `0`, `+12` or `-34`
 */
function signed(delta: number): string {
  if (delta === 0) return '0';
  return `${delta > 0 ? '+' : '-'}${tally(Math.abs(delta))}`;
}

/**
 * Render one before/after pair.
 *
 * @param label - What is being counted
 * @param value - The pair and its difference
 * @returns `user calls 436 -> 402 (-34)`
 */
function movementOf(label: string, value: IoCountDelta): string {
  return `${label} ${tally(value.before)} -> ${tally(value.after)} (${signed(value.delta)})`;
}

/**
 * Pluralise a noun against its count.
 *
 * @param value - How many
 * @param singular - The singular noun
 * @param plural - The plural noun
 * @returns The count and the right noun
 */
function quantity(value: number, singular: string, plural: string): string {
  return `${tally(value)} ${value === 1 ? singular : plural}`;
}

/**
 * How this facet's numbers are qualified when the machine was not idle.
 *
 * Carried even though call counts do not move with load: a capture that was
 * fighting for CPU may also have been fighting for the filesystem, and a reader
 * holding this beside a `perf` report from the same session needs the same tell
 * on both.
 */
const LOAD_PHRASING: LoadPhrasing = {
  unmeasured: 'these counts carry no contamination check.',
  contaminated: 'the counts stand, but the run was competing for the machine.',
};

/**
 * Say how repetitive a site's calls were, when they were repetitive at all.
 *
 * `distinctArgs` merged across processes is an UPPER bound on the number of
 * distinct files, so `count / distinctArgs` is a LOWER bound on the repetition —
 * hence `>=`. A flat `2.0x` would claim precision the merge cannot support.
 * A capped site makes no ratio claim at all: there the number is a floor, so the
 * ratio is bounded from the other side and the two bounds do not compose.
 *
 * @param site - The site row
 * @returns A suffix, or the empty string when the work was not repeated
 */
function repetitionNote(site: IoSite): string {
  // No reading, no ratio. There is nothing to divide by, and a row that made a
  // repetition claim from an absent reading would be the defect this guards.
  if (site.distinctArgs === null) return '';
  if (site.distinctArgs === 0 || site.count <= site.distinctArgs) return '';
  if (site.argsCapped) {
    return '  (repetition ratio unreadable — distinct args is a floor here)';
  }
  return `  >=${(site.count / site.distinctArgs).toFixed(RATIO_PRECISION)}x repeated`;
}

/**
 * How a site's distinct-argument reading is stated, including its absence.
 *
 * @param site - The site row
 * @returns The clause that follows the call count
 */
function distinctNote(site: IoSite): string {
  if (site.distinctArgs === null) {
    return NO_READING_NOTE;
  }
  return site.argsCapped
    ? `>=${tally(site.distinctArgs)} distinct args (CAPPED — a floor, not an exact count)`
    : `${tally(site.distinctArgs)} distinct args`;
}

/**
 * One call site, with the two numbers that make it judgeable.
 *
 * @param site - The site row
 * @returns A single line
 */
function siteLine(site: IoSite): string {
  return `      ${site.method}  ${site.site}  ${tally(site.count)} calls / ${distinctNote(site)}${repetitionNote(site)}`;
}

/**
 * State whether an exact delta may be read off this row's numbers.
 *
 * @param row - The command's statistics
 * @returns A single line, sitting directly beneath the counts it qualifies
 */
function stabilityLine(row: IoCommandStats): string {
  if (row.stable === true) {
    return '      repeats agreed — the counts above are deterministic, so an exact delta against another report is warranted.';
  }
  if (row.stable === false) {
    return "      ⚠ UNSTABLE — this command's own repeats disagreed, so a count delta against another report has no warrant.";
  }
  return `      ⚠ DETERMINISM UNTESTED — only ${quantity(row.comparedRuns, 'compared repeat', 'compared repeats')}, so nothing could have disagreed.`;
}

/**
 * The headline for one measured command.
 *
 * @param row - The command's statistics
 * @returns A single line carrying every aggregate
 */
function summaryLine(row: IoCommandStats): string {
  return (
    `  ${row.name} (${row.cache}, ${quantity(row.runs, 'run', 'runs')}, ` +
    `${tally(row.comparedRuns)} compared): ${tally(row.userCalls)} user calls across ` +
    `${quantity(row.sites.length, 'site', 'sites')}, ${tally(row.loaderCalls)} loader calls, ` +
    `${quantity(row.processes, 'process', 'processes')}`
  );
}

/**
 * Every line for one measured command.
 *
 * @param row - The command's statistics
 * @param maxSites - How many call sites to list
 * @returns The command's block
 */
function commandLines(row: IoCommandStats, maxSites: number): readonly string[] {
  if (row.failed) return [`  ${row.name}: FAILED — ${row.failure ?? 'unknown'}`];

  const lines = [summaryLine(row), stabilityLine(row)];
  if (row.processes === 1) lines.push(PROPAGATION_WARNING);
  lines.push(...row.sites.slice(0, maxSites).map((site) => siteLine(site)));

  const withheld = row.sites.length - Math.min(row.sites.length, maxSites);
  if (withheld > 0) {
    lines.push(
      `      ... ${quantity(withheld, 'more site not shown', 'more sites not shown')} ` +
        `(the ${tally(row.userCalls)} user-call total above already includes them)`,
    );
  }
  return lines;
}

/** Options for {@link renderIoReport}. */
export interface RenderIoReportOptions {
  /** How many call sites to list per command. Defaults to {@link DEFAULT_MAX_SITES}. */
  readonly maxSites?: number;
}

/**
 * Render a captured report.
 *
 * @param report - The report to render
 * @param options - See {@link RenderIoReportOptions}
 * @returns Text for a terminal
 */
export function renderIoReport(
  report: ReportEnvelope<IoBody>,
  options: RenderIoReportOptions = {},
): string {
  const maxSites = options.maxSites ?? DEFAULT_MAX_SITES;
  return [
    ...coordinateLines(report.coordinate),
    loadLine(report.body.load, LOAD_PHRASING),
    COUNTING_LEGEND,
    '',
    ...report.body.commands.flatMap((row) => commandLines(row, maxSites)),
  ].join('\n');
}

/**
 * The marker that opens a site-movement line.
 *
 * @param movement - The site's movement
 * @returns `+`, `-` or `~`
 */
function movementMarker(movement: IoSiteMovement): string {
  if (movement.kind === 'added') return '+';
  if (movement.kind === 'removed') return '-';
  return '~';
}

/**
 * One site's movement between two reports.
 *
 * @param movement - The site's movement
 * @returns A single line
 */
function siteMovementLine(movement: IoSiteMovement): string {
  const distinct =
    movement.distinctArgs === null
      ? ', distinct args NOT COMPARED'
      : `, ${movementOf('distinct args', movement.distinctArgs)}`;
  return (
    `      ${movementMarker(movement)} ${movement.method}  ${movement.site}  ` +
    `${movementOf('calls', movement.count)}${distinct}`
  );
}

/**
 * The three aggregate movements, on one line.
 *
 * @param movement - The command's movement
 * @returns A single line
 */
function totalsLine(movement: IoMovement): string {
  const { userCalls, loaderCalls, processes } = movement.totals;
  return [
    movementOf('user calls', userCalls),
    movementOf('loader calls', loaderCalls),
    movementOf('processes', processes),
  ].join(', ');
}

/**
 * Say how many sites went unchecked, so silence is not read as cleanliness.
 *
 * @param movement - The command's movement
 * @returns Zero or one line
 */
function caveatLines(movement: IoMovement): readonly string[] {
  if (movement.distinctArgsCaveat === null) return [];
  return [
    `      note: ${quantity(movement.unreadableDistinctArgs, 'site', 'sites')} could not have ` +
      `their distinct-argument counts compared — ${movement.distinctArgsCaveat}.`,
  ];
}

/**
 * Every line for one command's diff.
 *
 * @param diff - The command's diff row
 * @returns That command's block
 */
function diffLines(diff: IoComparisonResult['commands'][number]): readonly string[] {
  const verdict = diff.verdict;
  switch (verdict.kind) {
    case 'changed': {
      return [
        `  ${diff.name}: CHANGED — ${totalsLine(verdict.movement)}`,
        ...verdict.movement.sites.map((site) => siteMovementLine(site)),
        ...caveatLines(verdict.movement),
      ];
    }
    case 'unchanged': {
      const { userCalls, loaderCalls, processes } = verdict.movement.totals;
      return [
        `  ${diff.name}: unchanged — every count identical (${tally(userCalls.after)} user calls, ` +
          `${tally(loaderCalls.after)} loader calls, ${quantity(processes.after, 'process', 'processes')})`,
        ...caveatLines(verdict.movement),
      ];
    }
    case 'unwarranted': {
      return [
        `  ${diff.name}: NOT ATTRIBUTABLE — ${verdict.reason}`,
        `      the movement below is real, but it cannot be read as a difference in the subject: ${totalsLine(verdict.movement)}`,
        ...verdict.movement.sites.map((site) => siteMovementLine(site)),
        ...caveatLines(verdict.movement),
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
 * Render a comparison.
 *
 * @param comparison - A completed comparison
 * @returns Text for a terminal
 */
export function renderIoComparison(comparison: IoComparisonResult): string {
  return comparisonText({
    axis: comparison.axis,
    notes: comparison.contaminated ? [CONTAMINATION_NOTE] : [],
    legend: COUNTING_LEGEND,
    blocks: comparison.commands.flatMap((diff) => diffLines(diff)),
  });
}
