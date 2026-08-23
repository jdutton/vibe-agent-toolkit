/**
 * The parts of a rendered report that are the same in every facet.
 *
 * A facet owns how its own numbers read — a call count with its distinct-argument
 * reading, a pass with its share of the total. What it does not own is the frame
 * around them: which coordinate the report was taken at, how a busy machine is
 * disclosed, and the three sentences a comparison says about a command it could
 * not compare. Those are properties of *a lab report*, and three hand-written
 * copies would drift into three different ways of saying "we could not measure
 * this" — which is exactly the sentence a reader most needs to recognise
 * instantly, whichever facet produced it.
 *
 * The facet supplies its own nouns where the sentence needs one. `io` counts
 * calls and `parse` times passes, so a shared load line that said "these numbers"
 * would be worse than either.
 */

import type {
  Axis,
  Coordinate,
  InstrumentVersion,
  SubjectVersion,
} from '../envelope/coordinate.js';

import type { CountDelta, MsDelta } from './delta.js';
import type { LoadReadings } from './types.js';

/** How many characters of a hash identify it in a header. */
export const SHORT_HASH = 8;

/** Decimal places for a millisecond figure. */
const MS_PRECISION = 1;

/**
 * Decimal places for a per-unit figure.
 *
 * Three, because a per-document or per-call cost is routinely well under a
 * millisecond and one decimal place would render most of them as `0.0`.
 */
const PER_UNIT_PRECISION = 3;

/** Decimal places for a percentage share. */
const SHARE_PRECISION = 1;

/**
 * Format a millisecond value.
 *
 * @param value - Milliseconds
 * @returns A fixed-precision rendering
 */
export function ms(value: number): string {
  return `${value.toFixed(MS_PRECISION)}ms`;
}

/**
 * Render a signed millisecond difference.
 *
 * @param value - The signed difference
 * @returns `+12.3ms` or `-4.0ms`
 */
export function signedMs(value: number): string {
  return `${value >= 0 ? '+' : '-'}${ms(Math.abs(value))}`;
}

/**
 * One quantity per unit of another, or a dash when there is no denominator.
 *
 * A dash rather than `0.000`: dividing by zero units produces no reading, and a
 * zero there would read as "this row is free per unit" — which is the same class
 * of confident lie every other rule in these renderers exists to prevent.
 *
 * @param value - The numerator, in milliseconds
 * @param units - The denominator
 * @returns The per-unit figure, or `—`
 */
export function perUnit(value: number, units: number): string {
  return units === 0 ? '—' : (value / units).toFixed(PER_UNIT_PRECISION);
}

/**
 * A value's share of a total, or a dash when the total is zero.
 *
 * @param value - The part
 * @param total - The whole
 * @returns `12.3%`, or `—`
 */
export function share(value: number, total: number): string {
  return total === 0 ? '—' : `${((value / total) * 100).toFixed(SHARE_PRECISION)}%`;
}

/**
 * Render one before/after duration, unlabelled.
 *
 * @param value - The pair and its difference
 * @returns `921.6ms -> 812.0ms (-109.6ms)`
 */
export function msPair(value: MsDelta): string {
  return `${ms(value.before)} -> ${ms(value.after)} (${signedMs(value.delta)})`;
}

/**
 * Render one before/after duration with a label.
 *
 * @param label - What is being timed
 * @param value - The pair and its difference
 * @returns `total 921.6ms -> 812.0ms (-109.6ms)`
 */
export function msMovement(label: string, value: MsDelta): string {
  return `${label} ${msPair(value)}`;
}

/**
 * Render one before/after count.
 *
 * @param label - What is being counted
 * @param value - The pair and its difference
 * @returns `documents 1,364 -> 1,364 (0)`
 */
export function countMovement(label: string, value: CountDelta): string {
  const direction = value.delta > 0 ? '+' : '-';
  const signed = value.delta === 0 ? '0' : `${direction}${tally(Math.abs(value.delta))}`;
  return `${label} ${tally(value.before)} -> ${tally(value.after)} (${signed})`;
}

/**
 * Group a count for reading.
 *
 * Explicitly `en-US` rather than the ambient locale: a report rendered on one
 * machine and pasted next to a report rendered on another must not differ by
 * thousands separator alone.
 *
 * @param value - Any count
 * @returns The grouped rendering
 */
export function tally(value: number): string {
  return value.toLocaleString('en-US');
}

/**
 * Name a subject version for a header.
 *
 * @param version - Axis B
 * @returns A short label
 */
export function versionLabel(version: SubjectVersion): string {
  if (version.kind === 'snapshot') {
    return `snapshot ${version.fingerprint.slice(0, SHORT_HASH)} (${tally(version.fileCount)} files)`;
  }
  // A dirty tree is measurable but says so — the bytes measured were not the
  // bytes at that commit, and a reader comparing later must know that.
  return `${version.commit.slice(0, SHORT_HASH)}${version.dirty ? ' (DIRTY working tree)' : ''}`;
}

/**
 * Name an instrument build for a header.
 *
 * A dirty instrument says so in the same words the subject line uses, and for
 * the same reason: the bytes that ran were not the bytes at that commit, so the
 * commit alone is a claim the report cannot support. Rendering the two axes
 * differently would let a reader who has learned to look for the subject's
 * warning miss the identical warning on the instrument.
 *
 * @param instrument - Axis C
 * @returns A short label
 */
export function instrumentLabel(instrument: InstrumentVersion): string {
  const build = instrument.commit === null ? 'released' : instrument.commit.slice(0, SHORT_HASH);
  const dirty = instrument.dirty === true ? ', DIRTY working tree' : '';
  return `vat ${instrument.version} (${build}${dirty})`;
}

/**
 * The two coordinate lines at the top of a report.
 *
 * @param coordinate - Where the report was measured
 * @returns The subject line and the instrument line
 */
export function coordinateLines(coordinate: Coordinate): readonly string[] {
  const { subject, subjectVersion, instrument } = coordinate;
  return [
    `Subject:    ${subject.id} @ ${versionLabel(subjectVersion)}`,
    `Instrument: ${instrumentLabel(instrument)}`,
  ];
}

/**
 * Name the sides of a comparison a predicate holds on.
 *
 * @param before - The baseline instrument
 * @param after - The instrument compared against it
 * @param holds - The predicate
 * @returns `baseline`, `candidate`, `both` — or `null` when it holds on neither
 */
function sidesWhere(
  before: InstrumentVersion,
  after: InstrumentVersion,
  holds: (instrument: InstrumentVersion) => boolean,
): string | null {
  const sides = [holds(before) ? 'baseline' : null, holds(after) ? 'candidate' : null].filter(
    (side): side is string => side !== null,
  );
  if (sides.length === 2) return 'both arms';
  return sides[0] ?? null;
}

/**
 * What a comparison must say out loud about the two builds that produced it.
 *
 * **A stamp that misdescribes which code ran is a correctness bug, not a
 * cosmetic one**, and it is invisible at exactly the moment it matters: the
 * numbers are present, the header is well-formed, and the delta gets attributed
 * to a diff that was not the one under test. Two ways a coordinate can fail to
 * pin a build, both reported here rather than refused — a dirty A/B is a
 * legitimate thing to run during development, and forbidding it would forbid the
 * commonest use of the tool:
 *
 * - **A dirty arm.** Its `commit` names bytes that did not run. Nothing cheap
 *   identifies what did (see {@link InstrumentVersion.dirty}), so two dirty arms
 *   at one commit compare *equal* on axis C — this note is the only thing
 *   standing between that and a reader concluding the instrument was held still.
 * - **An arm with no commit at all** — a `dist:` path or an `npx:` spec. Two
 *   such arms carrying the same version are indistinguishable to `movedAxes`,
 *   which will report that *no* axis moved for what is genuinely a two-build
 *   comparison.
 *
 * @param before - The baseline instrument
 * @param after - The instrument compared against it
 * @returns Zero or more lines to print above the numbers they qualify
 */
export function instrumentTrustNotes(
  before: InstrumentVersion,
  after: InstrumentVersion,
): readonly string[] {
  const notes: string[] = [];

  const dirty = sidesWhere(before, after, (instrument) => instrument.dirty === true);
  if (dirty !== null) {
    notes.push(
      `⚠ INSTRUMENT NOT PINNED — ${dirty} built from a DIRTY working tree. The commit in the ` +
        'header names bytes that did not run, so this is NOT a commit-to-commit result. Nothing ' +
        'identifies a dirty build, so two dirty arms at one commit are indistinguishable here.',
    );
  }
  if (before.dirty !== after.dirty) {
    notes.push(
      `⚠ ARMS DIFFER IN DIRTINESS (baseline ${String(before.dirty)}, candidate ` +
        `${String(after.dirty)}) — part of the delta below may be uncommitted work rather than ` +
        'the change under test.',
    );
  }

  const unpinned = sidesWhere(before, after, (instrument) => instrument.commit === null);
  if (unpinned !== null) {
    notes.push(
      `⚠ NO COMMIT ON ${unpinned.toUpperCase()} — a dist: path or an npx: spec carries no ` +
        'provenance, so two such arms at one version look identical to the axis check and it ' +
        'will report that nothing moved. Prefer tree: when you have a checkout.',
    );
  }

  return notes;
}

/**
 * What a facet calls its own numbers when the load line has to mention them.
 *
 * Both clauses are the facet's because the *consequence* differs: call counts do
 * not move with machine load and durations do, so `io` says its numbers stand
 * while `perf` and `parse` say theirs are indicative only. A shared sentence
 * would have to be vague enough to be true of both, and vague is how a
 * qualification stops being read.
 */
export interface LoadPhrasing {
  /** Said when the platform reports no load at all. */
  readonly unmeasured: string;
  /** Said when the machine was busy. */
  readonly contaminated: string;
}

/**
 * Describe the machine a capture ran on.
 *
 * @param load - The readings taken around the capture
 * @param phrasing - See {@link LoadPhrasing}
 * @returns A single line
 */
export function loadLine(load: LoadReadings, phrasing: LoadPhrasing): string {
  const span = `${String(load.before)} -> ${String(load.after)} over ${tally(load.cpus)} CPUs`;
  if (!load.available) {
    return `Machine load: NOT MEASURED on this platform — ${phrasing.unmeasured}`;
  }
  if (load.contaminated) {
    return `Machine load: CONTAMINATED (${span}) — ${phrasing.contaminated}`;
  }
  return `Machine load: clean (${span}).`;
}

/**
 * The first line of a comparison.
 *
 * @param axis - Which axis varies, or `null` when the two share a coordinate
 * @returns A single line
 */
export function comparisonHeading(axis: Axis | null): string {
  return axis === null
    ? 'Comparing two reports at the same coordinate'
    : `Comparing along one axis: ${axis}`;
}

/** The frame every rendered comparison shares. */
export interface ComparisonFrame {
  /** Which axis varies, or `null` when the two share a coordinate. */
  readonly axis: Axis | null;
  /** Warnings that qualify every number below them — contamination, and the like. */
  readonly notes: readonly string[];
  /**
   * The facet's own one-line statement of what it measured.
   *
   * Printed on the comparison as well as the report, because either can be
   * pasted somewhere on its own and a number with no unit attached is the
   * easiest kind to misread.
   */
  readonly legend: string;
  /** The per-command blocks, already rendered. */
  readonly blocks: readonly string[];
}

/**
 * Assemble a rendered comparison.
 *
 * @param frame - See {@link ComparisonFrame}
 * @returns Text for a terminal
 */
export function comparisonText(frame: ComparisonFrame): string {
  return [comparisonHeading(frame.axis), ...frame.notes, frame.legend, '', ...frame.blocks].join(
    '\n',
  );
}

/**
 * What a comparison says about a command it could not compare.
 *
 * Its own sentence, never folded into "unchanged": "we could not measure this"
 * and "this did not move" are different facts, and a report that renders them
 * identically hides broken commands behind a reassuring green.
 *
 * @param name - The command
 * @param reason - Why there is no measurement
 * @returns The command's whole block
 */
export function noMeasurementLines(name: string, reason: string): readonly string[] {
  return [`  ${name}: NO MEASUREMENT — ${reason}`];
}

/**
 * What a comparison says about a command present on only one side.
 *
 * @param name - The command
 * @param present - Which side it appeared on
 * @returns The command's whole block
 */
export function oneSidedLines(name: string, present: 'added' | 'removed'): readonly string[] {
  return oneSidedLinesImpl(name, present);
}

/**
 * Everything a captured report prints above its command blocks.
 *
 * The order is the content and it is the same in every facet: where the
 * measurement was taken, whether the machine was busy, what the numbers are, then
 * the numbers. A facet that reordered it would be legible on its own and
 * illegible beside its siblings.
 *
 * @param frame - The coordinate, the load reading, the legend and the blocks
 * @returns Text for a terminal
 */
export function facetReportText(frame: {
  readonly coordinate: Coordinate;
  readonly load: LoadReadings;
  readonly phrasing: LoadPhrasing;
  readonly legend: string;
  readonly blocks: readonly string[];
}): string {
  return [
    ...coordinateLines(frame.coordinate),
    loadLine(frame.load, frame.phrasing),
    frame.legend,
    '',
    ...frame.blocks,
  ].join('\n');
}

/**
 * Render a whole captured report, given how the facet renders one command.
 *
 * @param report - The report to render
 * @param phrasing - How this facet's numbers are qualified on a busy machine
 * @param legend - The sentence that says what the numbers are
 * @param commandLines - How this facet renders one command
 * @returns Text for a terminal
 */
export function renderFacetReport<TRow>(
  report: { readonly coordinate: Coordinate; readonly body: { readonly commands: readonly TRow[]; readonly load: LoadReadings } },
  phrasing: LoadPhrasing,
  legend: string,
  commandLines: (row: TRow) => readonly string[],
): string {
  return facetReportText({
    coordinate: report.coordinate,
    load: report.body.load,
    phrasing,
    legend,
    blocks: report.body.commands.flatMap((row) => commandLines(row)),
  });
}

/**
 * Render a whole comparison, given how the facet renders one command's diff.
 *
 * @param comparison - A completed comparison
 * @param legend - The sentence that says what the numbers are
 * @param contaminationNote - What to say when either side was captured on a busy machine
 * @param diffLines - How this facet renders one command's diff
 * @returns Text for a terminal
 */
export function renderFacetComparison<TDiff>(
  comparison: {
    readonly axis: Axis | null;
    readonly commands: readonly TDiff[];
    readonly contaminated: boolean;
  },
  legend: string,
  contaminationNote: string,
  diffLines: (diff: TDiff) => readonly string[],
): string {
  return comparisonText({
    axis: comparison.axis,
    notes: comparison.contaminated ? [contaminationNote] : [],
    legend,
    blocks: comparison.commands.flatMap((diff) => diffLines(diff)),
  });
}

/** How one row's movement is marked, and what qualifies it. */
export interface MovementMark {
  /** `+` added, `-` removed, `~` a real move, a space for one within noise. */
  readonly marker: string;
  /** The trailing qualifier, empty unless the move was within noise. */
  readonly noise: string;
}

/**
 * Mark one row's movement.
 *
 * A row that merely moved within the gates gets a BLANK marker rather than a
 * `~`: every row prints, because the shape of the measurement is what a reader is
 * here for, but the eye should land only on the rows that are findings.
 *
 * @param kind - Whether the row is new, gone, or on both sides
 * @param significant - Whether a `changed` row cleared its gates
 * @returns The marker and the qualifier
 */
export function movementMark(
  kind: 'added' | 'removed' | 'changed',
  significant: boolean,
): MovementMark {
  const quiet = kind === 'changed' && !significant;
  return {
    marker: { added: '+', removed: '-', changed: quiet ? ' ' : '~' }[kind],
    noise: quiet ? '  (within noise)' : '',
  };
}

/**
 * The block a command prints when it has no breakdown, or `null` when it does.
 *
 * Both empty states are here because both are ways a well-formed report lies. A
 * failed row printed as zeroes reads as the fastest run ever measured; a row that
 * measured nothing printed as a table of zeroes reads as "this work is free".
 * Every facet has to refuse both, and a facet that refused only the first would
 * look correct until the day something stopped reaching its instrument.
 *
 * @param row - The command's shared identity fields
 * @param measured - Whether the row carries a real breakdown
 * @param note - What to say instead, when it does not
 * @param detail - Lines that stay worth printing even with no breakdown
 * @returns The block, or `null` when the caller should print its own
 */
export function unmeasuredBlock(
  row: {
    readonly name: string;
    readonly cache: string;
    readonly runs: number;
    readonly failed: boolean;
    readonly failure: string | null;
  },
  measured: boolean,
  note: string,
  detail: readonly string[],
): readonly string[] | null {
  if (row.failed) return [`  ${row.name}: FAILED — ${row.failure ?? 'unknown'}`];
  if (measured) return null;
  return [`  ${row.name} (${row.cache}, ${tally(row.runs)} runs): ${note}`, ...detail];
}

/**
 * Every line for one command's diff, whatever the facet subtracted.
 *
 * The three non-numeric verdicts are handled identically everywhere, and that is
 * the point: `added`, `removed` and "we could not measure this" are the sentences
 * a reader most needs to recognise instantly, whichever facet produced them.
 *
 * @param name - The command's name
 * @param verdict - Its verdict; `unmeasurable` must carry a reason
 * @param totals - The aggregate movements, as one clause
 * @param detail - The per-row lines, given whether anything moved
 * @returns That command's block
 */
export function verdictBlock(
  name: string,
  verdict:
    | { readonly kind: 'added' | 'removed' }
    | { readonly kind: 'unmeasurable'; readonly reason: string }
    | { readonly kind: 'changed' | 'unchanged' },
  totals: () => string,
  detail: (changed: boolean) => readonly string[],
): readonly string[] {
  if (verdict.kind === 'added' || verdict.kind === 'removed') {
    return oneSidedLinesImpl(name, verdict.kind);
  }
  if (verdict.kind === 'unmeasurable') return noMeasurementLines(name, verdict.reason);

  const changed = verdict.kind === 'changed';
  const headline = changed
    ? `  ${name}: CHANGED — ${totals()}`
    : `  ${name}: unchanged — ${totals()}, every move within noise`;
  return [headline, ...detail(changed)];
}

/**
 * The one-sided sentence, behind the public name.
 *
 * Split out only so {@link verdictBlock} can reach it without the shadowing that
 * a self-referential `oneSidedLines` would create.
 *
 * @param name - The command's name
 * @param present - Which side it appeared on
 * @returns The block
 */
function oneSidedLinesImpl(name: string, present: 'added' | 'removed'): readonly string[] {
  return present === 'added'
    ? [`  ${name}: new, no baseline to compare against`]
    : [`  ${name}: gone, present only in the baseline`];
}
