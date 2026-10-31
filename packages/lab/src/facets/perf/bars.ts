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
 * The rendered verdicts are headed by what every alias WAS — its coordinate
 * as given and what it resolved to — every input the caller chose that decided
 * the numbers, and the load the arms ran under.
 */

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
    readonly summary: BarSide | null;
    readonly failure: string | null;
    readonly repetitions: readonly { readonly violation: string | null }[];
  })[];
};

/** One bar's result. */
interface BarResult extends BarJudgement {
  readonly bar: Bar;
  /** Why the bar failed without a comparison, or `null`. */
  readonly reason: string | null;
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
    const tie = Math.abs(a - scaled) <= TIE_TOLERANCE * Math.max(Math.abs(a), Math.abs(scaled));
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

/** A factor: digits and a decimal point only (`Number` refuses a second point). */
const FACTOR = /^[\d.]+$/u;

/**
 * Parse one bar.
 *
 * @param text - `<build>:<sequence>:<state> <=|< <factor>*<build>:<sequence>:<state>`
 * @returns The bar, or why it does not parse
 */
export function parseBar(text: string): Bar | string {
  const malformed = `--bar expects <build>:<sequence>:<warm|cold> <=|< <factor>*<build>:<sequence>:<warm|cold>; got '${text}'`;
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
    if (left.summary !== null && right.summary !== null) {
      results.push({ bar, ...judgeBar(left.summary, bar.relation, right.summary, bar.factor), reason: null });
    } else {
      const unmeasured = left.summary === null ? left : right;
      const name = armName(unmeasured);
      const reason = `${name} has no measurement: ${unmeasured.failure ?? 'no repeats'}`;
      results.push({ bar, verdict: 'fail', median: false, min: false, reason });
    }
  }
  return { ok: true, results };
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
  ];
  return lines.length === 0 ? ['Inputs: none — no --env, --unset, --expect-exit, --prerequisite or --timeout-ms'] : ['Inputs:', ...lines];
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
