/**
 * An interleaved A/B: two instruments, alternated, over many pairs.
 *
 * ## Why this is a verb rather than a recipe
 *
 * `run` measures one instrument, so an A/B used to mean hand-orchestrating a
 * dozen separate invocations and comparing them by eye. That is not merely
 * tedious — it is where the wrong answers come from. Hand-orchestration has no
 * memory, so nothing enforces the three properties below, and a session using it
 * came within one reading of publishing an 8x result that was an artifact of the
 * ordering. Encoding the properties in a verb is the only way they survive the
 * next person in a hurry.
 *
 * ## The three properties, and what each one prevents
 *
 * **1. Whole arms alternate: A B A B …, never all of A then all of B.** A
 * machine drifts over minutes — another build starts, a browser wakes up,
 * thermals change — and a block design charges every bit of that drift to
 * whichever arm ran during it. Alternation converts a systematic bias into a
 * per-pair one that shows up as disagreement between pairs, which is a signal
 * you can read rather than one that silently favours an arm. The second reason
 * is specific to this harness: vat namespaces its dev parse cache per build, so
 * each arm's *first* invocation is cold whatever `--cache` says. Under a block
 * design that cold invocation is one sample out of many for each arm and
 * disappears into the aggregate; under alternation it recurs symmetrically and
 * the `min` estimator ignores it on both sides equally.
 *
 * **2. The estimator is `min`, with `p25` beside it — never a median, never a
 * mean.** See {@link Estimate}: every sample is the true cost plus a
 * non-negative contamination, so the smallest is the closest thing to a clean
 * observation, while one cold repeat is enough to move a median across a handful
 * of samples.
 *
 * **3. A single pair settles nothing.** Two pairs in a prior session actively
 * disagreed with each other. So every pair's verdict is reported individually
 * and the run says whether they agreed; a disagreement is printed as a
 * disagreement rather than averaged into a consensus that never existed. An
 * unstable verdict is not a result.
 *
 * ## What this module is not
 *
 * It does not measure and it does not compare. Capture, comparison and the
 * per-command verdicts all belong to the facet, and arrive here as functions —
 * so `ab` works for every facet, present and future, and cannot acquire an
 * opinion about what a `perf` verdict means versus an `io` one. The one number
 * it aggregates arrives through {@link FacetEstimate}, which carries its own unit
 * precisely so that nothing here has to know what it is.
 */

import { safePath } from '@vibe-agent-toolkit/utils';

import type { InstrumentVersion } from '../envelope/coordinate.js';
import type { ReportEnvelope } from '../envelope/envelope.js';
import { writeReport } from '../store.js';

import type { MeasuredCommandSpec } from './commands.js';
import { type Estimate, estimate } from './estimator.js';
import { coordinateLines, instrumentLabel, instrumentTrustNotes } from './render.js';
import type { CacheMode, CaptureRequest, ResolvedInstrument, ResolvedSubject } from './types.js';

/** The verdict kind that means a real, attributable difference was found. */
export const CHANGED_VERDICT = 'changed';
/** The verdict kind that means no usable measurement exists for a command. */
export const UNMEASURABLE_VERDICT = 'unmeasurable';

/** Stands in for a pair whose comparison refused, so it can never read as agreement. */
const NO_VERDICT = 'NO VERDICT (pair refused)';

/**
 * The least a comparison must expose for the CLI and `ab` to report it.
 *
 * Deliberately structural rather than a union of the facets' result types: the
 * job here is to print what a facet rendered, tally its verdicts and pick an
 * exit code, and nothing above the facet should acquire a reason to know what a
 * `perf` verdict is called versus an `io` one. A new facet wires itself up by
 * satisfying this and nothing else.
 */
export interface ComparisonLike {
  /** The discriminant, so a refusal and a result stay distinguishable here too. */
  readonly ok: true;
  readonly commands: readonly {
    readonly name: string;
    readonly verdict: { readonly kind: string };
  }[];
}

/** A comparison that refused, in the shape every facet's comparator returns. */
export interface RefusalLike {
  readonly ok: false;
  readonly refusal: string;
}

/**
 * One scalar a facet is willing to have aggregated across pairs.
 *
 * The unit travels with the number because this module must not know what the
 * number is. `perf` offers a command's fastest repeat in `ms`, `io` offers its
 * user call count in `calls`; both are aggregated by the identical code, which
 * only ever compares values that came from the same facet.
 */
export interface FacetEstimate {
  /** The measured command this describes, matching the comparison's row name. */
  readonly name: string;
  /** The scalar itself, already reduced from the repeats inside one capture. */
  readonly value: number;
  /** What the number is, for rendering only — `ms`, `calls`. */
  readonly unit: string;
}

/**
 * The three functions a facet supplies to everything above it.
 *
 * Declared once and extended by both consumers — the CLI's `FacetWiring` and
 * {@link AbSpec} — rather than written out at each. Two copies of a function
 * signature drift silently: an `ab` whose `compare` had picked up a fourth
 * option, or whose `capture` returned a differently-shaped envelope, would still
 * typecheck at its own call site while no longer being satisfiable by the
 * wiring the CLI passes it.
 */
export interface FacetFunctions<TBody, TComparison extends ComparisonLike> {
  readonly capture: (request: CaptureRequest) => Promise<ReportEnvelope<TBody>>;
  readonly compare: (
    before: ReportEnvelope<unknown>,
    after: ReportEnvelope<unknown>,
    options: { allowMultiAxis: boolean },
  ) => RefusalLike | TComparison;
  /**
   * The one scalar per command that {@link runAb} aggregates across pairs.
   *
   * Required rather than optional so no facet can quietly opt out and leave its
   * `ab` reporting verdict stability with no magnitude behind it — a verdict
   * with no number is exactly the unfalsifiable result this whole verb exists to
   * replace. The facet chooses the number and names its unit; nothing above this
   * interface ever interprets either, which is what keeps `ab` facet-agnostic
   * while still having something to take a minimum of.
   *
   * It must be a per-capture reduction that is already robust to a slow repeat —
   * `perf` publishes a command's fastest repeat, not its median — because `ab`
   * then takes a minimum *of these*, and a min over medians is not a min.
   */
  readonly estimate: (report: ReportEnvelope<TBody>) => readonly FacetEstimate[];
}

/** Everything an interleaved A/B needs, with the facet's parts injected. */
export interface AbSpec<TBody, TComparison extends ComparisonLike>
  extends FacetFunctions<TBody, TComparison> {
  readonly subject: ResolvedSubject;
  /**
   * The two arms, resolved once and reused for every pair.
   *
   * For a control run these are the *same object*, which is what guarantees the
   * two arms are stamped identically and that the run measures the machine
   * rather than a difference between builds.
   */
  readonly armA: ResolvedInstrument;
  readonly armB: ResolvedInstrument;
  readonly commands: readonly MeasuredCommandSpec[];
  /** How many A-then-B cycles to run. */
  readonly pairs: number;
  /** Repeats inside each single capture. */
  readonly runs: number;
  readonly cache: CacheMode;
  /** True when both arms are the same instrument, so this run IS the noise floor. */
  readonly control: boolean;
  /**
   * The noise floor a previous `--control` run measured, in the facet's own
   * units, or `null` when none was supplied.
   *
   * `null` is reported as *unmeasured*, never as zero. A run with no floor
   * cannot say whether an effect is real, and saying so is the whole point.
   */
  readonly noiseFloor: number | null;
  /** Directory the per-pair, per-arm reports are written under. */
  readonly outDir: string;
  /** The clock, supplied so the caller owns it. */
  readonly now: () => string;
}

/** One arm's aggregate for one command, across every pair. */
export interface AbArmSummary extends Estimate {
  /** The facet's unit for these values. */
  readonly unit: string;
}

/** How an effect stands against the machine's own spread. */
export type AbNoiseVerdict =
  /** This run is a control: the effect below IS the noise floor. */
  | 'control'
  /** No control has been run, so nothing is known about the floor. */
  | 'unmeasured'
  /** The effect is no larger than the supplied floor. */
  | 'indistinguishable'
  /** The effect exceeds the supplied floor. */
  | 'exceeds-floor';

/** What every pair said about one command, and what that adds up to. */
export interface AbCommandResult {
  readonly name: string;
  /** One verdict kind per pair, in the order the pairs ran. */
  readonly verdicts: readonly string[];
  /**
   * True when every pair said the same thing.
   *
   * False is not a weaker `changed` — it means the pairs contradicted each
   * other, and there is no result to report.
   */
  readonly stable: boolean;
  readonly a: AbArmSummary | null;
  readonly b: AbArmSummary | null;
  /** `b.min - a.min`, or `null` when either arm produced no reading. */
  readonly effect: number | null;
  readonly noise: AbNoiseVerdict;
}

/** A completed interleaved A/B. */
export interface AbResult {
  readonly control: boolean;
  readonly pairs: number;
  readonly runs: number;
  readonly cache: CacheMode;
  readonly noiseFloor: number | null;
  readonly outDir: string;
  /** One entry per pair whose comparison refused; empty on a healthy run. */
  readonly refusals: readonly string[];
  readonly commands: readonly AbCommandResult[];
  readonly instrumentA: InstrumentVersion;
  readonly instrumentB: InstrumentVersion;
  /** The header lines of the last capture, so the run names its coordinate. */
  readonly subjectLines: readonly string[];
}

/** What one A-then-B cycle produced. */
interface PairOutcome {
  readonly refusal: string | null;
  readonly verdicts: ReadonlyMap<string, string>;
  readonly a: ReadonlyMap<string, FacetEstimate>;
  readonly b: ReadonlyMap<string, FacetEstimate>;
  readonly coordinateLines: readonly string[];
}

/**
 * Index a facet's estimates by command name.
 *
 * @param estimates - What the facet published for one capture
 * @returns The estimates, keyed by command
 */
function byName(estimates: readonly FacetEstimate[]): ReadonlyMap<string, FacetEstimate> {
  return new Map(estimates.map((item) => [item.name, item]));
}

/**
 * Capture one arm of one pair and store it.
 *
 * Each capture lands in its own `pair-N/<arm>` directory rather than sharing the
 * store's flat namespace. Two pairs of one arm are the *same* coordinate, so
 * they name the same file — and without the per-pair directory the last pair
 * would silently overwrite the rest, leaving a run that reported six pairs with
 * two reports on disk.
 *
 * @param spec - The A/B being run
 * @param instrument - The arm's resolved instrument
 * @param pair - One-based pair number
 * @param arm - `a` or `b`
 * @returns The captured report
 */
async function captureArm<TBody, TComparison extends ComparisonLike>(
  spec: AbSpec<TBody, TComparison>,
  instrument: ResolvedInstrument,
  pair: number,
  arm: 'a' | 'b',
): Promise<ReportEnvelope<TBody>> {
  const report = await spec.capture({
    instrument,
    subject: spec.subject,
    commands: spec.commands,
    runs: spec.runs,
    cache: spec.cache,
    capturedAt: spec.now(),
  });
  await writeReport(safePath.join(spec.outDir, `pair-${String(pair)}`, arm), report);
  return report;
}

/**
 * Run one A-then-B cycle.
 *
 * The order is the content: arm A, then arm B, then the next pair. Running every
 * A and then every B is the design this verb exists to make unavailable.
 *
 * @param spec - The A/B being run
 * @param pair - One-based pair number
 * @returns What the pair produced
 */
async function runPair<TBody, TComparison extends ComparisonLike>(
  spec: AbSpec<TBody, TComparison>,
  pair: number,
): Promise<PairOutcome> {
  const a = await captureArm(spec, spec.armA, pair, 'a');
  const b = await captureArm(spec, spec.armB, pair, 'b');

  const comparison = spec.compare(a, b, { allowMultiAxis: false });
  const verdicts = comparison.ok
    ? new Map(comparison.commands.map((command) => [command.name, command.verdict.kind]))
    : new Map<string, string>();

  return {
    refusal: comparison.ok ? null : `pair ${String(pair)}: ${comparison.refusal}`,
    verdicts,
    a: byName(spec.estimate(a)),
    b: byName(spec.estimate(b)),
    coordinateLines: coordinateLines(a.coordinate),
  };
}

/**
 * Every command name any pair had something to say about.
 *
 * Taken from the union rather than from the first pair: a command that failed on
 * one pair and succeeded on another must still get a row, because that
 * inconsistency is exactly what a reader needs to see.
 *
 * @param outcomes - Every pair's outcome
 * @returns The names, sorted
 */
function commandNames(outcomes: readonly PairOutcome[]): readonly string[] {
  const names = new Set<string>();
  for (const outcome of outcomes) {
    for (const name of outcome.verdicts.keys()) names.add(name);
    for (const name of outcome.a.keys()) names.add(name);
    for (const name of outcome.b.keys()) names.add(name);
  }
  return [...names].sort((left, right) => left.localeCompare(right));
}

/**
 * Aggregate one arm's per-pair values for one command.
 *
 * @param outcomes - Every pair's outcome
 * @param name - The command
 * @param arm - Which arm to read
 * @returns The min, the p25 and every sample — or `null` when the arm never read
 */
function armSummary(
  outcomes: readonly PairOutcome[],
  name: string,
  arm: 'a' | 'b',
): AbArmSummary | null {
  const found = outcomes
    .map((outcome) => (arm === 'a' ? outcome.a : outcome.b).get(name))
    .filter((item): item is FacetEstimate => item !== undefined);
  if (found.length === 0) return null;
  return { ...estimate(found.map((item) => item.value)), unit: found[0]?.unit ?? '' };
}

/**
 * Judge an effect against the noise floor, saying plainly when there is none.
 *
 * @param spec - The A/B being run
 * @param effect - The measured effect, or `null` when there is no reading
 * @returns The verdict; `unmeasured` whenever no control has been run
 */
function judgeNoise<TBody, TComparison extends ComparisonLike>(
  spec: AbSpec<TBody, TComparison>,
  effect: number | null,
): AbNoiseVerdict {
  if (spec.control) return 'control';
  if (spec.noiseFloor === null || effect === null) return 'unmeasured';
  return Math.abs(effect) <= spec.noiseFloor ? 'indistinguishable' : 'exceeds-floor';
}

/**
 * Fold every pair into one row per command.
 *
 * @param spec - The A/B being run
 * @param outcomes - Every pair's outcome
 * @returns One row per command, sorted by name
 */
function foldCommands<TBody, TComparison extends ComparisonLike>(
  spec: AbSpec<TBody, TComparison>,
  outcomes: readonly PairOutcome[],
): readonly AbCommandResult[] {
  return commandNames(outcomes).map((name): AbCommandResult => {
    const verdicts = outcomes.map((outcome) => outcome.verdicts.get(name) ?? NO_VERDICT);
    const a = armSummary(outcomes, name, 'a');
    const b = armSummary(outcomes, name, 'b');
    const effect = a === null || b === null ? null : b.min - a.min;
    return {
      name,
      verdicts,
      stable: new Set(verdicts).size <= 1,
      a,
      b,
      effect,
      noise: judgeNoise(spec, effect),
    };
  });
}

/**
 * Run an interleaved A/B.
 *
 * @param spec - See {@link AbSpec}
 * @returns Every pair's verdict, folded per command
 */
export async function runAb<TBody, TComparison extends ComparisonLike>(
  spec: AbSpec<TBody, TComparison>,
): Promise<AbResult> {
  const outcomes: PairOutcome[] = [];
  for (let pair = 1; pair <= spec.pairs; pair++) {
    // Sequential on purpose: two captures in flight would compete for the very
    // machine whose spread this design exists to control for.
    outcomes.push(await runPair(spec, pair));
  }

  return {
    control: spec.control,
    pairs: spec.pairs,
    runs: spec.runs,
    cache: spec.cache,
    noiseFloor: spec.noiseFloor,
    outDir: spec.outDir,
    refusals: outcomes
      .map((outcome) => outcome.refusal)
      .filter((refusal): refusal is string => refusal !== null),
    commands: foldCommands(spec, outcomes),
    instrumentA: spec.armA.version,
    instrumentB: spec.armB.version,
    subjectLines: outcomes.at(-1)?.coordinateLines.slice(0, 1) ?? [],
  };
}

/**
 * Which of the CLI's existing exit conditions this run lands in.
 *
 * Keyed on the same verdict-kind strings `compare` keys on, so the two verbs
 * cannot drift into different answers to "what does a changed result exit
 * with?". The one addition is that an **unstable** verdict is not a result: the
 * pairs contradicted each other, which is nearer to "we could not measure this"
 * than to either answer they gave.
 *
 * @param result - A completed A/B
 * @returns The condition, for the caller to map to its exit code
 */
export function abExitCondition(
  result: AbResult,
): 'refused' | 'changed' | 'unmeasurable' | 'clean' {
  if (result.refusals.length > 0) return 'refused';
  const stablyChanged = result.commands.some(
    (command) => command.stable && command.verdicts[0] === CHANGED_VERDICT,
  );
  if (stablyChanged) return 'changed';
  const doubtful = result.commands.some(
    (command) => !command.stable || command.verdicts.includes(UNMEASURABLE_VERDICT),
  );
  return doubtful ? 'unmeasurable' : 'clean';
}

/** Most fraction digits any aggregate is printed with. */
const VALUE_PRECISION = 3;

/**
 * Format one aggregate, without pretending to a precision it does not have.
 *
 * @param value - The number
 * @returns Its rendering
 */
function num(value: number): string {
  return value.toLocaleString('en-US', { maximumFractionDigits: VALUE_PRECISION });
}

/**
 * The sentence that says how much the noise floor lets a reader conclude.
 *
 * @param result - A completed A/B
 * @returns A single line
 */
function noiseFloorLine(result: AbResult): string {
  if (result.control) {
    return (
      'Noise floor: THIS RUN IS THE CONTROL — both arms are the same instrument, so every effect ' +
      'below is the machine talking. Pass the largest of them as --noise-floor to the real A/B.'
    );
  }
  if (result.noiseFloor === null) {
    return (
      'Noise floor: UNMEASURED — no control was run and none was supplied, so nothing below can ' +
      'be called real. Re-run with --control (same instrument as both arms) to measure it.'
    );
  }
  return `Noise floor: ${num(result.noiseFloor)} (supplied via --noise-floor).`;
}

/**
 * How one command's per-pair verdicts read.
 *
 * @param command - The folded row
 * @returns One or two lines
 */
function verdictLines(command: AbCommandResult): readonly string[] {
  const listed = `    verdicts: ${command.verdicts.join(', ')}`;
  if (command.stable) return [listed];
  return [
    listed,
    `    ⚠ PAIRS DISAGREE — ${String(new Set(command.verdicts).size)} different verdicts across ` +
      `${String(command.verdicts.length)} pairs. This is not a result: averaging them would ` +
      'manufacture a consensus that no pair reported.',
  ];
}

/**
 * How one arm's aggregate reads.
 *
 * @param label - `A` or `B`
 * @param summary - The arm's aggregate, or `null` when it never read
 * @returns A single line
 */
function armLine(label: string, summary: AbArmSummary | null): string {
  if (summary === null) return `    ${label}: NO READING — this arm published no estimate.`;
  return (
    `    ${label}: min ${num(summary.min)}${summary.unit} p25 ${num(summary.p25)}${summary.unit} ` +
    `(per-pair: ${summary.samples.map((value) => num(value)).join(', ')})`
  );
}

/**
 * How one command's effect reads against the floor.
 *
 * @param command - The folded row
 * @param noiseFloor - The floor this run was given, or `null`
 * @returns A single line
 */
function effectLine(command: AbCommandResult, noiseFloor: number | null): string {
  if (command.effect === null) return '    effect: NONE — an arm produced no reading.';
  const unit = command.b?.unit ?? command.a?.unit ?? '';
  const head = `    effect (B - A): ${num(command.effect)}${unit}`;
  switch (command.noise) {
    case 'control': {
      return `${head} — the noise floor itself; nothing changed between these arms.`;
    }
    case 'unmeasured': {
      return `${head} — noise floor UNMEASURED, so this cannot be called real.`;
    }
    case 'indistinguishable': {
      return `${head} — INDISTINGUISHABLE FROM NOISE (floor ${num(noiseFloor ?? 0)}${unit}).`;
    }
    case 'exceeds-floor': {
      return `${head} — exceeds the supplied noise floor of ${num(noiseFloor ?? 0)}${unit}.`;
    }
  }
}

/**
 * Render a completed A/B.
 *
 * @param result - What {@link runAb} produced
 * @returns Text for a terminal
 */
export function renderAb(result: AbResult): string {
  const design =
    `A/B — ${String(result.pairs)} pairs, arms ALTERNATED (A B A B …), ` +
    `${String(result.runs)} runs per capture, ${result.cache} cache` +
    (result.control ? ', CONTROL (both arms are the same instrument)' : '');

  const blocks = result.commands.flatMap((command) => [
    `  ${command.name}`,
    ...verdictLines(command),
    armLine('A', command.a),
    armLine('B', command.b),
    effectLine(command, result.noiseFloor),
  ]);

  return [
    design,
    ...result.subjectLines,
    `Instrument A: ${instrumentLabel(result.instrumentA)}`,
    `Instrument B: ${instrumentLabel(result.instrumentB)}`,
    ...instrumentTrustNotes(result.instrumentA, result.instrumentB),
    'Estimator: MIN across pairs, with p25 beside it. Never a median — one cold repeat poisons it.',
    noiseFloorLine(result),
    ...result.refusals.map((refusal) => `⚠ ${refusal}`),
    '',
    ...blocks,
    '',
    `Reports: ${result.outDir}`,
  ].join('\n');
}
