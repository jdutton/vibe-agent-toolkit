/**
 * Human-readable rendering of `parse` reports and comparisons.
 *
 * Rendering is where an honest measurement most easily becomes a dishonest
 * claim, and this facet has five specific ways to do it:
 *
 * - **A minority parser's breakdown must never read as the tree's parse cost.**
 *   Eight neatly-aligned rows covering 3% of the time are the most convincing
 *   possible way to describe a corpus wrongly. Every measured row therefore
 *   names the dominant parser kind — or names the corpus as mixed — BEFORE any
 *   breakdown, each kind's block repeats its share of the whole, and every pass
 *   share is a share of its own kind's total rather than of the command's.
 *
 * - **Zeroes must never read as "free".** A warm run charges no passes at all,
 *   because vat's parse cache short-circuits the parse function on a hit. A
 *   table of zeroes and a total of `0.0ms` is a perfectly well-formed body that
 *   says "parsing costs nothing". Every non-`measured` row therefore renders as
 *   a sentence saying which of the empty states it is, and never as a table of
 *   zeroes — and so does a kind that never ran within an otherwise measured row.
 * - **The unattributed remainder is always printed**, including when it is
 *   small. It is the number that says whether the breakdown above it is a
 *   complete explanation or a partial one, and a report that only listed the
 *   passes it knew about would make an unfinished instrument look finished.
 * - **The cache split is a rate over EVERY parser kind**, and it is labelled as
 *   such. Presenting it as a per-document rate would invite the reader to
 *   reconcile it against the document count, which is not an arithmetic that
 *   holds: several call sites reach a parser without consulting the cache at
 *   all. That difference is *printed*, as the remainder it is, so a reader is
 *   never left to infer it and never invited to read it as an invariant.
 * - **These milliseconds are summed across processes, not wall time.** A vat
 *   command spawns a child per phase; the numbers add. The legend says so on
 *   both the report and the comparison, because either can be pasted somewhere
 *   on its own and a reader who took them for wall time would try to reconcile
 *   them against a `perf` median and never succeed.
 * - **Every pass figure is wall time, so a loaded machine inflates all of
 *   them.** The process-level CPU reading is what makes that visible, and the
 *   report says it in a sentence when the divergence is large rather than
 *   printing two numbers and leaving the reader to divide them.
 */

import type { ReportEnvelope } from '../../envelope/envelope.js';
import {
  countMovement,
  type LoadPhrasing,
  ms,
  movementMark,
  msMovement,
  msPair,
  perUnit,
  renderFacetComparison,
  renderFacetReport,
  share,
  tally,
  unmeasuredBlock,
  verdictBlock,
} from '../../harness/render.js';

import type { ParseComparisonResult, ParseMovement, ParsePassMovement } from './compare.js';
import type {
  ParseAttribution,
  ParseBody,
  ParseCommandStats,
  ParseKindStats,
  ParsePassStats,
} from './types.js';

/**
 * Below this, a negative remainder is float noise rather than a broken bracket.
 *
 * The seam emits unrounded `performance.now()` deltas summed across processes,
 * so the attributed passes can total a few thousandths of a millisecond more
 * than the bracket around them. Beyond this the bracketing is genuinely wrong,
 * and the report says so instead of printing a negative share.
 */
const REMAINDER_NOISE_MS = 0.05;

/**
 * Below this ratio of CPU time to wall time, the process spent a large part of
 * its life not running at all.
 *
 * The passes are wall-timed, so that waiting is inside every figure above. 0.7
 * is deliberately generous: a vat process reads a whole tree off disk, so some
 * divergence is normal and healthy, and a threshold that fired on it would train
 * a reader to ignore the warning that matters.
 */
const CPU_BOUND_FLOOR = 0.7;

/**
 * At or above this share of the parse budget, one parser kind is the story.
 *
 * Below it, no kind's breakdown describes the tree and the report says so
 * instead of leading with whichever happened to sort first. 0.8 rather than a
 * bare majority: at 55/45 both breakdowns matter, and calling either one
 * "dominant" would be the same overclaim in a quieter voice.
 */
const DOMINANCE_FLOOR = 0.8;

/**
 * The label that keeps a reader from reconciling these against a `perf` median.
 *
 * Printed on both the report and the comparison, because either can be pasted
 * somewhere on its own.
 */
const TIMING_LEGEND =
  'Timed: inside vat, per parse pass, summed across every process that dumped. Not wall ' +
  'time — a command spawns a child per phase and their milliseconds add.';

/** Said at the top of a comparison when either capture was contaminated. */
const CONTAMINATION_NOTE =
  '⚠  At least one side was captured on a contaminated machine. These are durations, so every ' +
  'delta below is suspect.';

/** How each empty state is said in a report, in place of a table of zeroes. */
const ATTRIBUTION_NOTES: Readonly<Record<ParseAttribution, string>> = {
  measured: '',
  'all-cache-hits':
    'EVERY DOCUMENT WAS A CACHE HIT — nothing to attribute. vat short-circuits the parse ' +
    'function on a hit, so no pass ran. Re-capture with --cache cold.',
  'uninstrumented-only':
    'THE CACHE MISSED BUT NO PARSER REPORTED — every parser kind this build knows about counts ' +
    'its documents, so the work went to one it does not know about, or the parses threw. Not a ' +
    'warm cache and not an idle command; something parsed and nothing said what.',
  'nothing-parsed':
    'NOTHING WAS PARSED AT ALL — no documents, no non-markdown parses, no cache hits, no cache ' +
    'misses. This is not a warm cache; the command never reached the parse path, so check that it ' +
    'measured what you think.',
  'not-measured': 'NO READING — see the failure on this row.',
};

/**
 * How this facet's numbers are qualified when the machine was not idle.
 *
 * These are durations, so unlike `io`'s counts they move with the machine —
 * hence "indicative only" rather than "the numbers stand".
 */
const LOAD_PHRASING: LoadPhrasing = {
  unmeasured: 'these timings carry no contamination check.',
  contaminated: 'treat these timings as indicative only.',
};

/**
 * The cache split, as a rate over every parser kind.
 *
 * @param row - The command's statistics
 * @returns A single line
 */
function cacheLine(row: ParseCommandStats): string {
  const looks = row.cacheHits + row.cacheMisses;
  const rate = share(row.cacheHits, looks);
  return (
    `      parse cache: ${tally(row.cacheHits)} hits / ${tally(row.cacheMisses)} misses ` +
    `(${rate} hit rate, ALL parser kinds — not a per-document rate; every kind counts here, ` +
    'and some parses never consult the cache)'
  );
}

/**
 * What is left over between the parses counted and the cache misses counted.
 *
 * Phrased as a remainder in every branch, because that is what it is: counters
 * measured independently in different places, and the difference between them. A
 * reader who took `parses - misses` for an invariant would read a healthy run as
 * a broken one the first time a call site skipped the cache.
 *
 * @param row - The command's statistics
 * @returns A clause completing the routes line
 */
function uncachedPhrase(row: ParseCommandStats): string {
  const left = row.uncachedParses;
  if (left < 0) {
    return (
      `⚠ ${tally(-left)} MORE cache misses than parses — a miss was counted for a parse that ` +
      'never completed, so these counters do not reconcile'
    );
  }
  if (left === 0) {
    return 'none is left over once the cache misses are subtracted (a remainder, not an invariant)';
  }
  return (
    `${tally(left)} never consulted the cache — the remainder after subtracting the cache ` +
    'misses, which is a difference between counters and not an invariant'
  );
}

/**
 * Which kind parsed what, and what the cache did not see.
 *
 * @param row - The command's statistics
 * @returns A single line
 */
function routesLine(row: ParseCommandStats): string {
  const split = row.kinds
    .map((kind) => `${tally(kind.documents)} ${kind.kind} (${tally(kind.bytes)} bytes)`)
    .join(' + ');
  return `      parse routes: ${split === '' ? 'none' : split}; ${uncachedPhrase(row)}`;
}

/**
 * Which parser kind this tree's parse cost actually belongs to.
 *
 * **The line this facet exists for.** A breakdown covering 3% of a tree's parse
 * time is not the shape of that tree, and eight neatly-formatted rows are the
 * most convincing possible way to say otherwise. So the dominant kind is named
 * before any breakdown is shown, and a mixed corpus is named as mixed rather
 * than left to the reader's eye.
 *
 * @param row - The command's statistics
 * @returns One line, or none when there is only one kind carrying any time
 */
function dominanceLines(row: ParseCommandStats): readonly string[] {
  const withTime = row.kinds.filter((kind) => kind.totalMs > 0);
  if (withTime.length < 2) return [];

  const ordered = [...withTime].sort((a, b) => b.totalMs - a.totalMs);
  const split = ordered
    .map((kind) => `${kind.kind} ${share(kind.totalMs, row.totalMs)}`)
    .join(' / ');
  const leader = ordered[0];
  if (leader === undefined || leader.totalMs / row.totalMs < DOMINANCE_FLOOR) {
    return [
      `      MIXED CORPUS — ${split} of parse time. No single kind's breakdown describes this ` +
        'tree; read each one against its own total.',
    ];
  }
  return [
    `      ${leader.kind.toUpperCase()} DOMINATES this corpus — ${split} of parse time ` +
      `(${tally(leader.documents)} of ${tally(row.documents)} documents). Read the ` +
      `${leader.kind} breakdown first; the others describe the remainder of the cost, not ` +
      'the shape of this tree.',
  ];
}

/**
 * Wall against CPU, and what that says about every wall figure on the row.
 *
 * Two lines rather than one when the divergence is large, because the second
 * line is a finding: the passes are wall-timed, so a process that spent its life
 * waiting has that waiting distributed through the whole breakdown. Making the
 * reader divide two numbers to discover that is exactly the inference this facet
 * exists to remove.
 *
 * @param row - The command's statistics
 * @returns One line, or two when the machine was not running the process
 */
function processLines(row: ParseCommandStats): readonly string[] {
  const cpu = row.cpuUserMs + row.cpuSystemMs;
  const head =
    `      process lifetime: ${ms(row.wallMs)} wall, ${ms(cpu)} CPU ` +
    `(${ms(row.cpuUserMs)} user + ${ms(row.cpuSystemMs)} system) summed over ` +
    `${tally(row.processes)} processes — the whole process, NOT the parse; ` +
    `CPU is ${share(cpu, row.wallMs)} of wall`;
  if (row.wallMs === 0 || cpu / row.wallMs >= CPU_BOUND_FLOOR) return [head];
  return [
    head,
    '      ⚠ THE PROCESS SPENT MOST OF ITS LIFE NOT RUNNING — waiting on I/O, or descheduled by a ' +
      'loaded machine. Every figure above is wall time and carries that waiting inside it, so treat ' +
      'the breakdown as indicative and re-capture on an idle machine before believing a share.',
  ];
}

/**
 * One pass, with the four figures that make it judgeable.
 *
 * The share is of the pass's OWN kind's total, never of the command's — a pass
 * belongs to one parser, and dividing it by the whole command's parse budget
 * would shrink every pass of a minority kind into invisibility while still
 * printing a percentage that looks authoritative.
 *
 * @param pass - The pass row
 * @param kind - The kind it belongs to, for the denominator and the documents
 * @returns A single line
 */
function passLine(pass: ParsePassStats, kind: ParseKindStats): string {
  return (
    `        ${pass.pass.padEnd(22)} ${ms(pass.elapsedMs).padStart(10)}  ` +
    `${share(pass.elapsedMs, kind.totalMs).padStart(7)} of ${kind.kind}  ` +
    `${tally(pass.calls).padStart(8)} calls  ` +
    `${perUnit(pass.elapsedMs, kind.documents)} ms/doc`
  );
}

/**
 * The line that says whether one kind's attribution is complete.
 *
 * @param kind - The kind's statistics
 * @returns A single line
 */
function remainderLine(kind: ParseKindStats): string {
  const rendered =
    `        unattributed           ${ms(kind.unattributedMs).padStart(10)}  ` +
    `${share(kind.unattributedMs, kind.totalMs).padStart(7)} of ${kind.kind}`;
  if (kind.unattributedMs < -REMAINDER_NOISE_MS) {
    return `${rendered}  ⚠ NEGATIVE — the passes sum to more than the bracket around them, so the seam's bracketing is wrong`;
  }
  return rendered;
}

/**
 * One parser kind: what it parsed, what it cost, and how that broke down.
 *
 * The heading carries the kind's share of the WHOLE command, so a reader who
 * skips the dominance line still cannot mistake a minority kind's tidy
 * breakdown for the tree's parse cost.
 *
 * @param kind - The kind's statistics
 * @param row - The command it belongs to, for the command-wide denominator
 * @returns That kind's block
 */
function kindLines(kind: ParseKindStats, row: ParseCommandStats): readonly string[] {
  const heading =
    `      ${kind.kind}: ${ms(kind.totalMs)} (${share(kind.totalMs, row.totalMs)} of all parse ` +
    `time) in ${tally(kind.totalCalls)} parses of ${tally(kind.documents)} documents ` +
    `(${tally(kind.bytes)} bytes)`;
  if (kind.totalCalls === 0) {
    // No parse of this kind ran. Printing its zeroed passes would be four rows
    // of `0.0ms` that read as "this parser is free" — the exact failure the
    // attribution states exist to prevent, one level down.
    return [`${heading} — this parser did not run, so there is nothing to attribute`];
  }
  return [heading, ...kind.passes.map((pass) => passLine(pass, kind)), remainderLine(kind)];
}

/**
 * State whether the repeats did the same work.
 *
 * @param row - The command's statistics
 * @returns A single line
 */
function stabilityLine(row: ParseCommandStats): string {
  if (row.stable === true) {
    return '      repeats parsed identical work — the breakdown above describes a reproducible run.';
  }
  if (row.stable === false) {
    return "      ⚠ UNSTABLE — this command's repeats parsed DIFFERENT work (documents, cache split or pass calls moved between them), so the breakdown describes one run and not the command.";
  }
  return '      ⚠ REPRODUCIBILITY UNTESTED — fewer than two repeats, so nothing could have disagreed.';
}

/**
 * The headline for one measured command.
 *
 * @param row - The command's statistics
 * @returns A single line carrying every aggregate
 */
function summaryLine(row: ParseCommandStats): string {
  const samples = row.totalMsSamples.map((sample) => ms(sample)).join(', ');
  return (
    `  ${row.name} (${row.cache}, ${tally(row.runs)} runs): ${ms(row.totalMs)} in ` +
    `${tally(row.totalCalls)} parses of ${tally(row.documents)} documents ` +
    `(${tally(row.bytes)} bytes) across ${tally(row.processes)} processes; ` +
    `repeat totals ${samples}`
  );
}

/**
 * Every line for one measured command.
 *
 * @param row - The command's statistics
 * @returns The command's block
 */
function commandLines(row: ParseCommandStats): readonly string[] {
  const empty = unmeasuredBlock(row, row.attribution === 'measured', ATTRIBUTION_NOTES[row.attribution], [
    cacheLine(row),
    routesLine(row),
    ...processLines(row),
  ]);
  if (empty !== null) return empty;
  return [
    summaryLine(row),
    ...dominanceLines(row),
    stabilityLine(row),
    cacheLine(row),
    routesLine(row),
    ...processLines(row),
    ...row.kinds.flatMap((kind) => kindLines(kind, row)),
  ];
}

/**
 * Render a captured report.
 *
 * @param report - The report to render
 * @returns Text for a terminal
 */
export function renderParseReport(report: ReportEnvelope<ParseBody>): string {
  return renderFacetReport(report, LOAD_PHRASING, TIMING_LEGEND, commandLines);
}

/**
 * One pass's movement between two reports.
 *
 * A pass that did not clear the gates still prints, marked as noise: the shape
 * of the parse is what the reader is here for, and a list of only the movers
 * makes one shifted pass look like the whole pipeline.
 *
 * @param movement - The pass's movement
 * @returns A single line
 */
function passMovementLine(movement: ParsePassMovement): string {
  const { marker, noise } = movementMark(movement.kind, movement.elapsedMs.significant);
  return (
    `      ${marker} ${movement.label.padEnd(22)} ${msPair(movement.elapsedMs)}, ` +
    `${countMovement('calls', movement.calls)}${noise}`
  );
}

/**
 * The aggregate movements, on one line.
 *
 * @param movement - The command's movement
 * @returns A single line
 */
function totalsLine(movement: ParseMovement): string {
  return [
    msMovement('total', movement.total),
    msMovement('unattributed', movement.unattributedMs),
    countMovement('documents', movement.documents),
  ].join(', ');
}

/**
 * Say what qualifies a movement, so silence is not read as comparability.
 *
 * @param movement - The command's movement
 * @returns Zero or one line
 */
function caveatLines(movement: ParseMovement): readonly string[] {
  return movement.caveat === null ? [] : [`      note: ${movement.caveat}.`];
}

/**
 * Every line for one command's diff.
 *
 * An if-chain rather than a switch because the two comparable verdicts differ
 * only in their headline and in whether the passes are worth listing — the
 * movement, and the caveat that qualifies it, belong to both.
 *
 * @param diff - The command's diff row
 * @returns That command's block
 */
function diffLines(diff: ParseComparisonResult['commands'][number]): readonly string[] {
  const movementOf = (): ParseMovement => (diff.verdict as { movement: ParseMovement }).movement;
  return verdictBlock(
    diff.name,
    diff.verdict,
    () => totalsLine(movementOf()),
    // The per-pass lines are the finding when something moved; on an unchanged
    // command they would be eight rows of "(within noise)" nobody reads. The
    // caveat qualifies both, so it is outside that choice.
    (changed) => [
      ...(changed ? movementOf().passes.map((pass) => passMovementLine(pass)) : []),
      ...caveatLines(movementOf()),
    ],
  );
}

/**
 * Render a comparison.
 *
 * @param comparison - A completed comparison
 * @returns Text for a terminal
 */
export function renderParseComparison(comparison: ParseComparisonResult): string {
  return renderFacetComparison(comparison, TIMING_LEGEND, CONTAMINATION_NOTE, diffLines);
}
