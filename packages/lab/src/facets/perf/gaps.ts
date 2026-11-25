/**
 * What an edit costs: the gap between an edit arm and the clean warm arm of the
 * same build, sequence and invocation, and the bars over it.
 *
 * A **gap** is `median(<build>:<seq>:warm-edit<N>) - median(<build>:<seq>:warm)`.
 * Both terms come from one build in one invocation, whose rounds interleaved
 * them, so the machine's load lands on both alike. A gap is never taken across
 * two builds or two invocations: an edit arm with no same-build clean arm in
 * the report has no gap, and a bar naming it is refused.
 *
 * A gap bar is written beside the ratio bars (`bars.ts`), in two forms:
 *
 * - `gap(<build>:<seq>:warm-edit<N>) <= <factor>*gap(<build>:<seq>:warm-edit<N>)`
 * - `gap(<build>:<seq>:warm-edit<N>) <= <seconds>s`
 *
 * It holds on the median gap. It is judged only when every arm it reads has an
 * IQR smaller than the bar's margin — the distance between the gap and the
 * bound it is held to — each arm gated on its own, a right-side gap's arms
 * with their IQR scaled by the factor (`noiseBoundReason`, measurement rule 5
 * as written: a gap's own spread is up to the sum of its two arms' IQRs, so a
 * margin just above each is a narrow pass); otherwise it is **noise-bound**:
 * re-run with more rounds, and a bar still inside the noise is reported
 * noise-bound, never passed.
 *
 * When one build has a `warm-edit1` arm and a `warm-edit<N>` arm of one kind,
 * the report also records its marginal per-file cost,
 * `(gap(warm-edit<N>) - gap(warm-edit1)) / (N - 1)`, with each arm's IQR.
 */

import { isEditState } from '../../harness/arm-state.js';
import type { EditState } from '../../harness/types.js';

import { type ArmName, armName, findArm, incompleteArm, parseArmName } from './arms-report-file.js';
import { isTie, noiseBoundReason, type NoiseReading } from './bars.js';
import type { PerfSummary } from './stats.js';

/** What a gap reads of an arm: its identity, statistics, failure and repetitions. */
export type GapArm = ArmName & {
  readonly summary: Pick<PerfSummary, 'medianMs' | 'iqrMs'> | null;
  readonly failure: string | null;
  readonly repetitions: readonly { readonly violation: string | null }[];
};

/** One edit arm's gap to its clean arm. */
export interface ArmGap {
  readonly build: string;
  readonly sequence: string;
  /** The edit arm's state, in its spelling (`warm-edit1`). */
  readonly state: string;
  readonly gapMs: number;
  readonly editIqrMs: number;
  readonly cleanIqrMs: number;
}

/** One build's marginal per-file cost between its one-file edit arm and a wider one. */
export interface MarginalCost {
  readonly build: string;
  readonly sequence: string;
  /** The wider arm's state (`warm-edit50`); the narrow one is `warm-edit1` of the same kind. */
  readonly state: string;
  readonly perFileMs: number;
  readonly oneFileIqrMs: number;
  readonly wideIqrMs: number;
  readonly cleanIqrMs: number;
}

/** A gap bar's bound: another gap scaled, or seconds. */
export type GapBound =
  | { readonly kind: 'factor'; readonly factor: number; readonly right: ArmName }
  | { readonly kind: 'seconds'; readonly seconds: number };

/** A parsed gap bar. */
export interface GapBar {
  /** As written, for the report. */
  readonly text: string;
  /** The edit arm whose gap the bar holds. */
  readonly left: ArmName;
  readonly bound: GapBound;
}

/** A gap bar's result. */
interface GapBarResult {
  readonly bar: GapBar;
  readonly verdict: 'pass' | 'fail' | 'noise-bound';
  /** The left gap and the bound it was held to, or `null` when an arm had no measurement. */
  readonly gapMs: number | null;
  readonly boundMs: number | null;
  /** Why the verdict is what it is, for the rendered line. */
  readonly detail: string;
}

/** A gap bar: `gap(<arm>) <= <factor>*gap(<arm>)` or `gap(<arm>) <= <seconds>s`. */
const GAP_BAR = /^gap\(([^)]*)\)<=(?:([\d.]+)\*gap\(([^)]*)\)|([\d.]+)s)$/u;

/**
 * @param text - A `--bar` value
 * @returns Whether it is written as a gap bar, so {@link parseGapBar} owns it
 */
export function isGapBarText(text: string): boolean {
  return text.trim().startsWith('gap(');
}

/**
 * Parse one gap bar.
 *
 * @param text - See the module header for the two forms
 * @returns The bar, or why it does not parse
 */
export function parseGapBar(text: string): GapBar | string {
  const malformed =
    `--bar expects gap(<build>:<seq>:warm-edit<N>) <= <factor>*gap(<build>:<seq>:warm-edit<N>) ` +
    `or gap(<build>:<seq>:warm-edit<N>) <= <seconds>s; got '${text}'`;
  const match = GAP_BAR.exec(text.replaceAll(/\s+/gu, ''));
  if (match === null) return malformed;
  const [, leftText = '', factorText, rightText, secondsText] = match;
  const left = parseEditArm(leftText);
  if (typeof left === 'string') return `--bar '${text}': ${left}`;
  if (secondsText !== undefined) {
    const seconds = Number(secondsText);
    if (!Number.isFinite(seconds) || seconds <= 0) return `--bar '${text}': ${secondsText}s is not a positive number of seconds`;
    return { text: text.trim(), left, bound: { kind: 'seconds', seconds } };
  }
  const right = parseEditArm(rightText ?? '');
  if (typeof right === 'string') return `--bar '${text}': ${right}`;
  const factor = Number(factorText);
  if (!Number.isFinite(factor) || factor <= 0) return `--bar '${text}': factor ${String(factorText)} is not a positive finite number`;
  if (armName(left) === armName(right)) return `--bar '${text}' compares gap(${armName(left)}) with itself — it cannot fail, so it says nothing`;
  return { text: text.trim(), left, bound: { kind: 'factor', factor, right } };
}

/**
 * @param text - One side of a gap bar
 * @returns The edit arm it names, or why it names none
 */
function parseEditArm(text: string): ArmName | string {
  const arm = parseArmName(text);
  if (arm === null) return `'${text}' is not an arm name`;
  return isEditState(arm.state) ? arm : `${armName(arm)} is not an edit arm — a gap is an edit arm's (warm-edit<N>)`;
}

/**
 * The clean warm arm an edit arm's gap is taken against: the same build and
 * sequence, state `warm`, in the same report.
 *
 * @param arms - The report's arms
 * @param edit - The edit arm
 * @returns The clean arm, or why there is none
 */
function cleanArmOf<T extends ArmName>(arms: readonly T[], edit: ArmName): T | string {
  const clean = findArm(arms, { build: edit.build, arm: edit.arm, state: 'warm' });
  return typeof clean === 'string'
    ? `gap(${armName(edit)}) has no same-build clean arm: ${edit.build}:${edit.arm}:warm is not in the invocation`
    : clean;
}

/**
 * Every edit arm's gap to its same-build clean arm, where both have a
 * measurement — what the arms report records.
 *
 * @param arms - The report's arms
 * @returns One gap per measured edit arm with a measured clean arm
 */
export function armGaps(arms: readonly GapArm[]): ArmGap[] {
  return arms.flatMap((arm): ArmGap[] => {
    if (!isEditState(arm.state) || arm.summary === null) return [];
    const clean = cleanArmOf(arms, arm);
    if (typeof clean === 'string' || clean.summary === null) return [];
    return [
      {
        build: arm.build,
        sequence: arm.arm,
        state: armName(arm).slice(`${arm.build}:${arm.arm}:`.length),
        gapMs: arm.summary.medianMs - clean.summary.medianMs,
        editIqrMs: arm.summary.iqrMs,
        cleanIqrMs: clean.summary.iqrMs,
      },
    ];
  });
}

/**
 * Each build's marginal per-file cost: for every wider edit arm beside a
 * `warm-edit1` of the same build, sequence and kind.
 *
 * @param gaps - {@link armGaps} of a report's arms
 * @returns One cost per wider arm
 */
export function marginalCosts(gaps: readonly ArmGap[]): MarginalCost[] {
  const stateOf = (gap: ArmGap): EditState | null => {
    const arm = parseArmName(`${gap.build}:${gap.sequence}:${gap.state}`);
    return arm !== null && isEditState(arm.state) ? arm.state : null;
  };
  return gaps.flatMap((wide): MarginalCost[] => {
    const state = stateOf(wide);
    if (state === null || state.count === 1) return [];
    const one = gaps.find((gap) => {
      const other = stateOf(gap);
      return gap.build === wide.build && gap.sequence === wide.sequence && other?.count === 1 && other.kind === state.kind;
    });
    if (one === undefined) return [];
    return [
      {
        build: wide.build,
        sequence: wide.sequence,
        state: wide.state,
        perFileMs: (wide.gapMs - one.gapMs) / (state.count - 1),
        oneFileIqrMs: one.editIqrMs,
        wideIqrMs: wide.editIqrMs,
        cleanIqrMs: wide.cleanIqrMs,
      },
    ];
  });
}

/** One gap, read for a bar: its value and the arms it read, or why it has none. */
type GapReading =
  | { readonly kind: 'measured'; readonly gapMs: number; readonly arms: readonly GapArm[] }
  | { readonly kind: 'unmeasured'; readonly reason: string }
  | { readonly kind: 'refused'; readonly refusal: string };

/**
 * @param arms - The report's arms
 * @param edit - The edit arm a bar names
 * @returns Its gap and the two arms behind it, why it has none, or the refusal
 */
function readGap(arms: readonly GapArm[], edit: ArmName): GapReading {
  const found = findArm(arms, edit);
  if (typeof found === 'string') return { kind: 'refused', refusal: found };
  const clean = cleanArmOf(arms, edit);
  if (typeof clean === 'string') return { kind: 'refused', refusal: clean };
  const both = [found, clean];
  // As `judgeBars`: an unfailed incomplete arm is a hand-edited or foreign file, refused; a failed one fails the bar.
  const incomplete = both.filter((arm) => arm.failure === null).map((arm) => incompleteArm(arm)).find((why) => why !== null);
  if (incomplete !== undefined) return { kind: 'refused', refusal: incomplete };
  for (const arm of both) {
    if (arm.summary === null) return { kind: 'unmeasured', reason: `${armName(arm)} has no measurement: ${arm.failure ?? 'no repeats'}` };
  }
  const [edited, cleaned] = [found.summary, clean.summary];
  /* c8 ignore next -- both summaries were checked just above; guards the narrowing */
  if (edited === null || cleaned === null) return { kind: 'unmeasured', reason: 'no measurement' };
  return { kind: 'measured', gapMs: edited.medianMs - cleaned.medianMs, arms: both };
}

/**
 * Judge every gap bar against an arms report.
 *
 * @param arms - The report's arms
 * @param bars - The parsed gap bars
 * @returns One result per bar, or the refusal naming the first bar that cannot be judged
 */
export function judgeGapBars(
  arms: readonly GapArm[],
  bars: readonly GapBar[],
): { readonly ok: true; readonly results: readonly GapBarResult[] } | { readonly ok: false; readonly refusal: string } {
  const results: GapBarResult[] = [];
  for (const bar of bars) {
    const left = readGap(arms, bar.left);
    const right = bar.bound.kind === 'factor' ? readGap(arms, bar.bound.right) : null;
    const refused = [left, right].find((reading) => reading?.kind === 'refused');
    if (refused?.kind === 'refused') return { ok: false, refusal: `--bar '${bar.text}': ${refused.refusal}` };
    results.push(judgeGapBar(bar, left, right));
  }
  return { ok: true, results };
}

/**
 * @param bar - The bar
 * @param left - Its edit arm's gap
 * @param right - The other gap of a factor bar, or `null` for a seconds bar
 * @returns The bar's result
 */
function judgeGapBar(bar: GapBar, left: GapReading, right: GapReading | null): GapBarResult {
  const unmeasured = [left, right].find((reading) => reading?.kind === 'unmeasured');
  if (unmeasured?.kind === 'unmeasured' || left.kind !== 'measured') {
    const reason = unmeasured?.kind === 'unmeasured' ? unmeasured.reason : 'no measurement';
    return { bar, verdict: 'fail', gapMs: null, boundMs: null, detail: reason };
  }
  const factor = bar.bound.kind === 'factor' ? bar.bound.factor : 1;
  const boundMs = right?.kind === 'measured' ? factor * right.gapMs : secondsBound(bar.bound);
  // Each arm is gated on its own IQR (rule 5 as written); a right-side gap's arms scale with the factor, as it does.
  const read = [
    ...left.arms.map((arm) => noiseReading(arm, 1)),
    ...(right?.kind === 'measured' ? right.arms.map((arm) => noiseReading(arm, factor)) : []),
  ];
  const noise = noiseBoundReason(read, Math.abs(boundMs - left.gapMs));
  const holds = left.gapMs < boundMs || isTie(left.gapMs, boundMs);
  const figures = `gap ${ms(left.gapMs)}, bound ${ms(boundMs)}`;
  if (noise !== null) return { bar, verdict: 'noise-bound', gapMs: left.gapMs, boundMs, detail: `${figures}; ${noise}` };
  return { bar, verdict: holds ? 'pass' : 'fail', gapMs: left.gapMs, boundMs, detail: figures };
}

/**
 * @param arm - An arm a gap bar reads
 * @param scale - The bar's factor on its side (1 on the left)
 * @returns Its name and scaled IQR; an unmeasured arm never reaches here, and reads as unbounded noise
 */
function noiseReading(arm: GapArm, scale: number): NoiseReading {
  return { name: armName(arm), iqrMs: scale * (arm.summary?.iqrMs ?? Number.POSITIVE_INFINITY) };
}

/**
 * @param bound - A gap bar's bound
 * @returns A seconds bound in milliseconds; a factor bound reaching here had no measured right gap
 */
function secondsBound(bound: GapBound): number {
  return bound.kind === 'seconds' ? bound.seconds * MS_PER_SECOND : Number.NaN;
}

/** Milliseconds in a second. */
const MS_PER_SECOND = 1000;

/**
 * @param value - Milliseconds
 * @returns The rendered figure
 */
function ms(value: number): string {
  return `${value.toFixed(1)}ms`;
}

/**
 * One line per gap bar.
 *
 * @param results - What {@link judgeGapBars} returned
 * @returns The rendered lines
 */
export function renderGapBars(results: readonly GapBarResult[]): readonly string[] {
  return results.map((result) => `${result.verdict.toUpperCase()}  ${result.bar.text}  (${result.detail})`);
}

/**
 * The gap and marginal lines of a rendered arms report.
 *
 * @param gaps - {@link armGaps}
 * @param marginals - {@link marginalCosts}
 * @returns The lines
 */
export function renderGaps(gaps: readonly ArmGap[], marginals: readonly MarginalCost[]): readonly string[] {
  return [
    ...gaps.map(
      (gap) => `gap ${gap.build}:${gap.sequence}:${gap.state}: ${ms(gap.gapMs)}  (edit IQR ${ms(gap.editIqrMs)}, clean IQR ${ms(gap.cleanIqrMs)})`,
    ),
    ...marginals.map(
      (cost) =>
        `marginal ${cost.build}:${cost.sequence}:${cost.state}: ${ms(cost.perFileMs)} per file  ` +
        `(IQR one-file ${ms(cost.oneFileIqrMs)}, wide ${ms(cost.wideIqrMs)}, clean ${ms(cost.cleanIqrMs)})`,
    ),
  ];
}
