/**
 * A pass bar between two timed arms.
 *
 * A bar holds only if it holds on the median AND on the min. The median is the
 * typical run and the min is the best the machine managed; when they disagree
 * the comparison says more about the machine than about VAT, so the verdict is
 * INCONCLUSIVE — re-run on a quiet machine — and an inconclusive bar never
 * counts as a pass. Ties pass under `≤` and fail under `<` — a tie being equal
 * within {@link TIE_TOLERANCE}, since `1.15 × 100` is not 115 in binary floating point.
 *
 * A bar is written `<build>:<sequence>:<state> <=|< <factor>*<build>:<sequence>:<state>`
 * — each side in `perf arms --arm`'s spelling — and the factor is REQUIRED:
 * `1` says "no slower", and a bar that omitted it would read as a claim nobody
 * made. A bar over an arm with no measurement fails, naming why, and a bar
 * comparing an arm with itself is refused: it cannot fail. A report holding an
 * arm that did not fail and is still not complete ({@link incompleteArm}: a
 * repetition broke its rule, or fewer than five repetitions) is refused whole.
 *
 * A bar naming an edit arm (`warm-edit<N>`) is also held to measurement rule 5
 * ({@link noiseBoundReason}): inside the noise it is NOISE-BOUND, never passed.
 *
 * The rendered verdicts are headed by what every alias WAS — its coordinate
 * as given and what it resolved to — every input the caller chose that decided
 * the numbers, and the load the arms ran under.
 */

import { isEditState } from '../../harness/arm-state.js';
import { instrumentLabel, loadLine } from '../../harness/render.js';
import type { InstrumentSource } from '../../harness/types.js';

import {
  type ArmName,
  armName,
  type ArmsInputs,
  type ArmsReportFile,
  findArm,
  incompleteArm,
  parseArmName,
} from './arms-report-file.js';
import type { PerfSummary } from './stats.js';

/** The two statistics a bar reads from each arm. */
export type BarSide = Pick<PerfSummary, 'medianMs' | 'minMs'>;

/** How the left arm must compare to the (scaled) right arm. */
export type BarRelation = '<=' | '<';

/** A bar's outcome, and which statistic held. */
export interface BarJudgement {
  readonly verdict: 'pass' | 'fail' | 'inconclusive';
  readonly median: boolean;
  readonly min: boolean;
}

/** One arm of an arms report, as a bar names it. */
export type BarArm = ArmName;

/** A parsed bar. */
export interface Bar {
  /** As written, for the report. */
  readonly text: string;
  readonly left: BarArm;
  readonly relation: BarRelation;
  readonly factor: number;
  readonly right: BarArm;
}

/** What a bar reads from an arms report: the inputs, builds and load, and each arm's statistics or why it has none. */
type BarReport = Pick<ArmsReportFile, 'builds' | 'inputs' | 'load'> & {
  readonly arms: readonly (BarArm & {
    readonly summary: (BarSide & Pick<PerfSummary, 'iqrMs'>) | null;
    readonly failure: string | null;
    readonly repetitions: readonly { readonly violation: string | null }[];
  })[];
};

/** One bar's result: a bar over an edit arm can also be noise-bound. */
interface BarResult extends Omit<BarJudgement, 'verdict'> {
  readonly verdict: BarJudgement['verdict'] | 'noise-bound';
  readonly bar: Bar;
  /** Why the bar failed without a comparison, or was noise-bound, or `null`. */
  readonly reason: string | null;
}

/** One arm a bar reads, with its IQR as the bar scales it (a right side's by the factor). */
export interface NoiseReading {
  readonly name: string;
  readonly iqrMs: number;
}

/**
 * Measurement rule 5: a bar is judged only when every arm it reads has an IQR
 * under the bar's margin — the distance between the left statistic and the
 * bound it is held to. Each arm is gated on its own, as the rule is written; a
 * right-side arm's IQR is scaled by the bar's factor, as its median is.
 *
 * @param read - Every arm the bar reads
 * @param margin - The bar's margin, in milliseconds
 * @returns Why the bar is noise-bound, or `null` when it may be judged
 */
export function noiseBoundReason(read: readonly NoiseReading[], margin: number): string | null {
  const noisy = read.find((each) => each.iqrMs >= margin);
  if (noisy === undefined) return null;
  return `${noisy.name} IQR ${noisy.iqrMs.toFixed(1)}ms is not under the margin ${margin.toFixed(1)}ms — re-run with more rounds`;
}

/**
 * Judge `left relation factor × right`, on the median and on the min.
 *
 * @param left - The arm the bar constrains
 * @param relation - `<=` (a tie passes) or `<` (a tie fails)
 * @param right - The arm it is compared with
 * @param factor - The tolerance on the right arm (`1.15` for "at most 15% slower", `1` for none)
 * @returns The verdict, and which statistic held
 * @throws {Error} when `factor` is not a positive finite number
 */
export function judgeBar(left: BarSide, relation: BarRelation, right: BarSide, factor: number): BarJudgement {
  if (!isFactor(factor)) {
    throw new Error(`judgeBar: factor ${String(factor)} is not a positive finite number`);
  }
  const holds = (a: number, b: number): boolean => {
    const scaled = b * factor;
    const tie = isTie(a, scaled);
    return relation === '<=' ? a < scaled || tie : a < scaled && !tie;
  };
  const median = holds(left.medianMs, right.medianMs);
  const min = holds(left.minMs, right.minMs);
  let verdict: BarJudgement['verdict'] = 'inconclusive';
  if (median && min) verdict = 'pass';
  else if (!median && !min) verdict = 'fail';
  return { verdict, median, min };
}

/** Relative: two statistics this close are one value, whatever the float product of a factor rounds to. */
const TIE_TOLERANCE = 1e-9;

/**
 * @param a - A statistic
 * @param b - A (scaled) statistic it is compared with
 * @returns Whether the two are one value within {@link TIE_TOLERANCE} — the one tie every bar uses
 */
export function isTie(a: number, b: number): boolean {
  return Math.abs(a - b) <= TIE_TOLERANCE * Math.max(Math.abs(a), Math.abs(b));
}

/** A factor: digits and a decimal point only (`Number` refuses a second point). */
const FACTOR = /^[\d.]+$/u;

/**
 * Parse one bar.
 *
 * @param text - `<build>:<sequence>:<state> <=|< <factor>*<build>:<sequence>:<state>`
 * @returns The bar, or why it does not parse
 */
export function parseBar(text: string): Bar | string {
  const malformed = `--bar expects <build>:<sequence>:<state> <=|< <factor>*<build>:<sequence>:<state> (state: warm, cold or warm-edit<N>[:<kind>]), or a gap bar; got '${text}'`;
  // The relation splits the bar in two: the first '<', and '<=' when '=' follows it.
  const at = text.indexOf('<');
  const relation: BarRelation = text[at + 1] === '=' ? '<=' : '<';
  const leftText = at === -1 ? '' : text.slice(0, at);
  const rest = at === -1 ? '' : text.slice(at + relation.length);
  const star = rest.indexOf('*');
  const left = parseArmName(leftText);
  const right = parseArmName(star === -1 ? rest : rest.slice(star + 1));
  if (left === null || right === null) return malformed;
  if (star === -1) return `--bar '${text}' names no factor — write 1* for "no slower"; a factor is never implied`;
  const factor = rest.slice(0, star).trim();
  const value = Number(factor);
  if (!FACTOR.test(factor) || !isFactor(value)) return `--bar '${text}': factor ${factor} is not a positive finite number`;
  const name = armName(left);
  if (name === armName(right)) return `--bar '${text}' compares ${name} with itself — it cannot fail, so it says nothing`;
  return { text: text.trim(), left, relation, factor: value, right };
}

/**
 * Judge every bar against an arms report.
 *
 * @param report - `arms-report.json`, or anything carrying its arms
 * @param bars - The parsed bars
 * @returns One result per bar, or the refusal naming an arm the report does not hold, or an unfailed
 *   incomplete arm a bar names
 */
export function judgeBars(
  report: BarReport,
  bars: readonly Bar[],
): { readonly ok: true; readonly results: readonly BarResult[] } | { readonly ok: false; readonly refusal: string } {
  const results: BarResult[] = [];
  for (const bar of bars) {
    const left = findArm(report.arms, bar.left);
    const right = findArm(report.arms, bar.right);
    if (typeof left === 'string') return { ok: false, refusal: `--bar '${bar.text}': ${left}` };
    if (typeof right === 'string') return { ok: false, refusal: `--bar '${bar.text}': ${right}` };
    // A failed arm fails the bar, naming its failure, below. An unfailed one that is still
    // incomplete is no report `perf arms` writes — a hand-edited or foreign file — so the bar
    // naming it is refused; an arm no bar names is never read.
    const incomplete = [left, right].filter((arm) => arm.failure === null).map((arm) => incompleteArm(arm)).find((why) => why !== null);
    if (incomplete !== undefined) return { ok: false, refusal: `--bar '${bar.text}': ${incomplete}` };
    results.push(judgeFoundBar(bar, left, right));
  }
  return { ok: true, results };
}

/**
 * @param bar - The bar
 * @param left - Its left arm, found and complete or failed
 * @param right - Its right arm
 * @returns The bar's result: judged, noise-bound, or failed naming the unmeasured arm
 */
function judgeFoundBar(bar: Bar, left: BarReport['arms'][number], right: BarReport['arms'][number]): BarResult {
  if (left.summary !== null && right.summary !== null) {
    const judged = judgeBar(left.summary, bar.relation, right.summary, bar.factor);
    const noise = editBarNoise(bar, left.summary, right.summary);
    return noise === null ? { bar, ...judged, reason: null } : { bar, ...judged, verdict: 'noise-bound', reason: noise };
  }
  const unmeasured = left.summary === null ? left : right;
  const reason = `${armName(unmeasured)} has no measurement: ${unmeasured.failure ?? 'no repeats'}`;
  return { bar, verdict: 'fail', median: false, min: false, reason };
}

/**
 * Rule 5 for a ratio bar naming an edit arm: its margin is the distance
 * between the left median and the scaled right median. A bar over clean and
 * cold arms only is judged on median and min as before.
 *
 * @param bar - The bar
 * @param left - Its left arm's statistics
 * @param right - Its right arm's
 * @returns Why it is noise-bound, or `null`
 */
function editBarNoise(bar: Bar, left: Pick<PerfSummary, 'medianMs' | 'iqrMs'>, right: Pick<PerfSummary, 'medianMs' | 'iqrMs'>): string | null {
  if (!isEditState(bar.left.state) && !isEditState(bar.right.state)) return null;
  return noiseBoundReason(
    [
      { name: armName(bar.left), iqrMs: left.iqrMs },
      { name: armName(bar.right), iqrMs: bar.factor * right.iqrMs },
    ],
    Math.abs(left.medianMs - bar.factor * right.medianMs),
  );
}

/**
 * What every alias was and the load the arms ran under, then one line per
 * bar: its verdict, the bar, and which statistic held.
 *
 * @param report - The arms report the bars were judged over
 * @param results - What {@link judgeBars} returned
 * @returns The rendered lines
 */
export function renderBars(report: BarReport, results: readonly BarResult[]): string {
  return [
    'Builds:',
    ...report.builds.map((build) => `  ${build.alias}: ${instrumentLabel(build.instrument)} from ${sourceLabel(build.source)}`),
    ...inputLines(report.inputs),
    loadLine(report.load, LOAD_PHRASING),
    ...results.map((result) => `${result.verdict.toUpperCase()}  ${result.bar.text}  (${detailOf(result)})`),
  ].join('\n');
}

/** What the load line says about bars. */
const LOAD_PHRASING = {
  unmeasured: 'these verdicts carry no contamination check.',
  contaminated: 'treat these verdicts as indicative only.',
} as const;

/**
 * @param inputs - What the caller chose for the arms
 * @returns The inputs, each in the flag spelling that chose it
 */
function inputLines(inputs: ArmsInputs): readonly string[] {
  const lines = [
    ...Object.entries(inputs.env.set).map(([key, value]) => `  --env ${key}=${value}`),
    ...inputs.env.unset.map((key) => `  --unset ${key}`),
    ...inputs.expectedExits.map((expected) => `  --expect-exit ${expected.build}:${expected.sequence}:${expected.step}=${String(expected.exit)}`),
    ...inputs.prerequisites.map((prerequisite) => `  --prerequisite ${prerequisite}`),
    ...(inputs.timeoutMs === null ? [] : [`  --timeout-ms ${String(inputs.timeoutMs)}`]),
    ...[...new Set(inputs.edits.flatMap((edit) => edit.paths ?? []))].map((path) => `  --edit ${path}`),
  ];
  return lines.length === 0
    ? ['Inputs: none — no --env, --unset, --expect-exit, --prerequisite, --timeout-ms or --edit']
    : ['Inputs:', ...lines];
}

/**
 * @param source - An instrument as the operator named it
 * @returns Its `--build` spelling
 */
function sourceLabel(source: InstrumentSource): string {
  return source.kind === 'npx' ? `npx:${source.spec}` : `${source.kind}:${source.path}`;
}

/**
 * @param result - One bar's result
 * @returns Why it came out as it did
 */
function detailOf(result: BarResult): string {
  if (result.reason !== null) return result.reason;
  if (result.verdict === 'pass') return 'median and min both hold';
  if (result.verdict === 'fail') return 'neither median nor min holds';
  return result.median
    ? 'median holds, min does not — re-run on a quiet machine'
    : 'min holds, median does not — re-run on a quiet machine';
}

/**
 * @param factor - A candidate factor
 * @returns Whether it is a positive finite number
 */
function isFactor(factor: number): boolean {
  return Number.isFinite(factor) && factor > 0;
}
