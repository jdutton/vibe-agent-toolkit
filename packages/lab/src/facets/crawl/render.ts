/**
 * Human-readable rendering of `crawl` reports and comparisons.
 *
 * Five ways an honest measurement becomes a dishonest claim here, and what each
 * costs:
 *
 * - **The per-stratum split is printed FIRST, and it is the line the facet
 *   exists for.** VAT has two crawlers live at once, and the question that has
 *   never had a number under it is which of them costs more to do its own work.
 *   A list of contributor rows sorted by id buries that answer inside itself.
 * - **The entry column does not add up to the total, and must say so.** Some
 *   brackets sit inside others, and those rows are excluded from every total
 *   here. A reader who tries to reconcile the column against the headline and
 *   fails will trust neither, so nested rows are marked `⊂` and the time they
 *   account for is stated on its own line rather than left to be inferred.
 * - **Zeroes must never read as "free".** A command that never reached a crawler
 *   produces an empty entry list, which prints as nothing at all and reads as an
 *   instant crawl. Such a row renders as a sentence naming the state instead.
 * - **These milliseconds are summed across processes, not wall time.** A vat
 *   command spawns a child per phase and the numbers add. The legend says so on
 *   both the report and the comparison, because either can be pasted somewhere
 *   on its own.
 * - **Process lifetimes are printed PER PROCESS and never totalled.** The
 *   brackets are wall-timed, so a reader needs the CPU-to-wall ratio to know
 *   whether to trust them — but there is no honest sum of lifetimes across a
 *   parent and its children, and printing one is how the `parse` facet's trust
 *   ratio came to be systematically deflated. Each process gets its own line and
 *   its own ratio.
 */

import type { ReportEnvelope } from '../../envelope/envelope.js';
import {
  countMovement,
  type LoadPhrasing,
  ms,
  movementMark,
  msPair,
  perUnit,
  renderFacetComparison,
  renderFacetReport,
  share,
  tally,
  unmeasuredBlock,
  verdictBlock,
} from '../../harness/render.js';

import type { CrawlComparisonResult, CrawlMovement, CrawlRowMovement } from './compare.js';
import { crawlRoleTotalOf } from './dump.js';
import type {
  CrawlAttribution,
  CrawlBody,
  CrawlCommandStats,
  CrawlProcessStats,
  CrawlRowRole,
} from './types.js';

/**
 * Below this ratio of CPU time to wall time, a process spent a large part of its
 * life not running at all.
 *
 * The brackets are wall-timed, so that waiting is inside every figure above.
 * Judged per process, never against a total — see this module's header.
 */
const CPU_BOUND_FLOOR = 0.7;

/**
 * The label that keeps a reader from reconciling these against a `perf` median.
 *
 * Printed on both the report and the comparison, because either can be pasted
 * somewhere on its own.
 */
const TIMING_LEGEND =
  'Timed: inside vat, per (contributor, stratum, pass), summed across every process that ' +
  'dumped. Not wall time — a command spawns a child per phase and their milliseconds add. ' +
  'Totals count only top-level brackets; a row marked ⊂ is charged from INSIDE one above it ' +
  'and is already in its total.';

/** Said at the top of a comparison when either capture was contaminated. */
const CONTAMINATION_NOTE =
  '⚠  At least one side was captured on a contaminated machine. These are durations, so every ' +
  'delta below is suspect.';

/** How each empty state is said in a report, in place of an empty table. */
const ATTRIBUTION_NOTES: Readonly<Record<CrawlAttribution, string>> = {
  measured: '',
  'nothing-crawled':
    'NOTHING WAS CRAWLED AT ALL — the seam ran and charged no brackets, so the command reached ' +
    'neither a projection contributor nor a link walk. This is not an instrument failure (a ' +
    'build with no seam produces no dump and fails the row instead); check that the command ' +
    'measured what you think.',
  'not-measured': 'NO READING — see the failure on this row.',
};

/**
 * How this facet's numbers are qualified when the machine was not idle.
 *
 * These are durations, so unlike `io`'s counts they move with the machine.
 */
const LOAD_PHRASING: LoadPhrasing = {
  unmeasured: 'these timings carry no contamination check.',
  contaminated: 'treat these timings as indicative only.',
};

/**
 * Which layer owns this command's crawl cost.
 *
 * **The line this facet exists for.** Every stratum, with its share, on one line,
 * before any per-contributor detail — so the incumbent walker and the projection
 * closure are read against each other rather than reconstructed from ids.
 *
 * Additive rows only, which is what makes the two comparable at all: nested
 * brackets sit at different depths on the two arms, so a figure that included
 * them would compare a walk against a walk-plus-its-oracle. The nested time is
 * on {@link nestingLine} beneath.
 *
 * @param row - The command's statistics
 * @returns One line
 */
function strataLine(row: CrawlCommandStats): string {
  const split = row.strata
    .map((stratum) => `${stratum.stratum} ${ms(stratum.elapsedMs)} (${share(stratum.elapsedMs, row.totalMs)})`)
    .join(' / ');
  return `      by stratum: ${split === '' ? 'none' : split}`;
}

/**
 * What the line above deliberately left out, and whether anything was dropped.
 *
 * Printed unconditionally when there is any, rather than only when it is large:
 * a reader who does not know a total excludes nested brackets will reconcile it
 * against the entry rows below and conclude the report does not add up.
 *
 * Unclassified time gets its own sentence because it is not a breakdown — it is
 * an admission that the total above is short by an unknown amount.
 *
 * @param row - The command's statistics
 * @returns The line, or nothing when every row was additive
 */
function nestingLine(row: CrawlCommandStats): readonly string[] {
  const nested = crawlRoleTotalOf(row.strata, (stratum) => stratum.nested);
  const unplaced = crawlRoleTotalOf(row.strata, (stratum) => stratum.unclassified);
  if (nested.calls === 0 && unplaced.calls === 0) return [];
  const parts = [
    `      of which nested inside the rows above (NOT added): ${ms(nested.elapsedMs)} in ` +
      `${tally(nested.calls)} invocations`,
  ];
  if (unplaced.calls > 0) {
    parts.push(
      `      ⚠ ${tally(unplaced.calls)} invocations (${ms(unplaced.elapsedMs)}) could not be ` +
        'placed as either — this build does not know whether they nest, so they are in NEITHER ' +
        'total above and the crawl cost is an UNDER-count. A vat grew a bracket this lab has ' +
        'never heard of; see `crawlRowRole`.',
    );
  }
  return parts;
}

/**
 * One process's lifetime and what it says about the figures above it.
 *
 * Per process, with its own ratio, and never summed — see this module's header.
 *
 * @param entry - One process's lifetime
 * @returns One line
 */
function processLine(entry: CrawlProcessStats): string {
  const cpu = entry.cpuUserMs + entry.cpuSystemMs;
  const warning =
    entry.wallMs > 0 && cpu / entry.wallMs < CPU_BOUND_FLOOR
      ? '  ⚠ spent most of its life NOT RUNNING; the wall-timed rows above carry that waiting'
      : '';
  return (
    `        pid ${String(entry.pid).padStart(7)}  ${ms(entry.wallMs).padStart(10)} wall  ` +
    `${ms(cpu).padStart(10)} CPU  ${share(cpu, entry.wallMs).padStart(7)} of wall${warning}`
  );
}

/**
 * Every process's lifetime, headed by a line saying what they are not.
 *
 * @param row - The command's statistics
 * @returns The block
 */
function processLines(row: CrawlCommandStats): readonly string[] {
  return [
    `      process lifetimes (${tally(row.processes.length)} dumps) — the whole process, NOT the ` +
      'crawl, and deliberately never summed: a parent orchestrator is alive for its children, so ' +
      'a total would double-count real time',
    ...row.processes.map((entry) => processLine(entry)),
  ];
}

/**
 * How each role is marked on an entry line.
 *
 * A marker rather than a column of words: the distinction only has to survive
 * being read next to a number that would otherwise look additive, and `⊂` says
 * "inside something above" more compactly than any label.
 */
const ROLE_MARKS: Readonly<Record<CrawlRowRole, string>> = {
  additive: ' ',
  nested: '⊂',
  unclassified: '?',
};

/**
 * One `(contributorId, stratum, pass)` row.
 *
 * The share is of the command's whole crawl budget, and for a row marked `⊂` it
 * is a share of a total this row is not part of — that is the point. The mark is
 * what keeps a reader from adding the column up: a nested row's milliseconds are
 * real, and are already inside the row that brackets it.
 *
 * @param entry - The row
 * @param row - The command it belongs to, for the denominator
 * @returns One line
 */
function entryLine(entry: CrawlCommandStats['entries'][number], row: CrawlCommandStats): string {
  const passLabel = entry.pass === 0 ? 'all' : String(entry.pass);
  return (
    `      ${ROLE_MARKS[entry.role]} ${entry.stratum.padEnd(8)} ${entry.contributorId.padEnd(34)} ` +
    `pass ${passLabel.padStart(3)}  ${ms(entry.elapsedMs).padStart(10)}  ` +
    `${share(entry.elapsedMs, row.totalMs).padStart(7)}  ${tally(entry.calls).padStart(8)} calls  ` +
    `${perUnit(entry.elapsedMs, entry.calls)} ms/call`
  );
}

/**
 * State whether the repeats did the same work.
 *
 * @param row - The command's statistics
 * @returns One line
 */
function stabilityLine(row: CrawlCommandStats): string {
  if (row.stable === true) {
    return '      repeats crawled identical work — the breakdown above describes a reproducible run.';
  }
  if (row.stable === false) {
    return "      ⚠ UNSTABLE — this command's repeats charged DIFFERENT rows or different call counts, so the breakdown describes one run and not the command.";
  }
  return '      ⚠ REPRODUCIBILITY UNTESTED — fewer than two repeats, so nothing could have disagreed.';
}

/**
 * The headline for one measured command.
 *
 * @param row - The command's statistics
 * @returns One line
 */
function summaryLine(row: CrawlCommandStats): string {
  const samples = row.totalMsSamples.map((sample) => ms(sample)).join(', ');
  return (
    `  ${row.name} (${row.cache}, ${tally(row.runs)} runs): ${ms(row.totalMs)} in ` +
    `${tally(row.totalCalls)} invocations across ${tally(row.processes.length)} processes; ` +
    `repeat totals ${samples}`
  );
}

/**
 * Every line for one command.
 *
 * @param row - The command's statistics
 * @returns The command's block
 */
function commandLines(row: CrawlCommandStats): readonly string[] {
  const empty = unmeasuredBlock(
    row,
    row.attribution === 'measured',
    ATTRIBUTION_NOTES[row.attribution],
    processLines(row),
  );
  if (empty !== null) return empty;
  return [
    summaryLine(row),
    strataLine(row),
    ...nestingLine(row),
    stabilityLine(row),
    ...processLines(row),
    ...row.entries.map((entry) => entryLine(entry, row)),
  ];
}

/**
 * Render a captured report.
 *
 * @param report - The report to render
 * @returns Text for a terminal
 */
export function renderCrawlReport(report: ReportEnvelope<CrawlBody>): string {
  return renderFacetReport(report, LOAD_PHRASING, TIMING_LEGEND, commandLines);
}

/**
 * One row's movement between two reports.
 *
 * A row that did not clear the gates still prints, marked as noise: the shape of
 * the crawl is what the reader is here for.
 *
 * @param movement - The row's movement
 * @param indent - Leading spaces, so strata and entries nest
 * @returns One line
 */
function rowMovementLine(movement: CrawlRowMovement, indent: string): string {
  const { marker, noise } = movementMark(movement.kind, movement.elapsedMs.significant);
  return (
    `${indent}${marker} ${movement.label.padEnd(48)} ${msPair(movement.elapsedMs)}, ` +
    `${countMovement('calls', movement.calls)}${noise}`
  );
}

/**
 * The aggregate movements, on one line.
 *
 * @param movement - The command's movement
 * @returns One line
 */
function totalsLine(movement: CrawlMovement): string {
  return `total ${msPair(movement.total)}, ${countMovement('invocations', movement.totalCalls)}`;
}

/**
 * Every line for one command's diff.
 *
 * @param diff - The command's diff row
 * @returns That command's block
 */
function diffLines(diff: CrawlComparisonResult['commands'][number]): readonly string[] {
  return verdictBlock(
    diff.name,
    diff.verdict,
    () => totalsLine((diff.verdict as { movement: CrawlMovement }).movement),
    // The strata always print on a changed command: which crawler moved is the
    // finding, and it is one line each. The entries print beneath them. On an
    // unchanged command they would be rows of "(within noise)" nobody reads.
    (changed) => {
      if (!changed) return [];
      const { movement } = diff.verdict as { movement: CrawlMovement };
      return [
        ...movement.strata.map((row) => rowMovementLine(row, '    ')),
        ...movement.entries.map((row) => rowMovementLine(row, '      ')),
      ];
    },
  );
}

/**
 * Render a comparison.
 *
 * @param comparison - A completed comparison
 * @returns Text for a terminal
 */
export function renderCrawlComparison(comparison: CrawlComparisonResult): string {
  return renderFacetComparison(comparison, TIMING_LEGEND, CONTAMINATION_NOTE, diffLines);
}
