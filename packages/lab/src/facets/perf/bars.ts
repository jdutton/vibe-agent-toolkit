/**
 * A pass bar between two timed arms.
 *
 * A bar holds only if it holds on the median AND on the min. The median is the
 * typical run and the min is the best the machine managed; when they disagree
 * the comparison says more about the machine than about VAT, so the verdict is
 * INCONCLUSIVE — re-run on a quiet machine — and an inconclusive bar never
 * counts as a pass. Ties pass under `≤` and fail under `<`.
 *
 * A bar is written `<build>:<sequence>:<state> <=|< <factor>*<build>:<sequence>:<state>`
 * — each side in `perf arms --arm`'s spelling — and the factor is REQUIRED:
 * `1` says "no slower", and a bar that omitted it would read as a claim nobody
 * made. A bar over an arm with no measurement fails, naming why.
 */

import { readFileSync } from 'node:fs';

import { z } from 'zod';

import type { CacheMode } from '../../harness/types.js';

import type { PerfSummary } from './stats.js';

/**
 * What a bar reads from `arms-report.json`. `.strip()` on purpose: a bar
 * judges only each arm's identity, summary and failure; the rest of the
 * report (repetitions, step stderr, removed names) is the arms facet's record,
 * and this reader whitelists rather than re-declaring it.
 */
const BarReportSchema = z
  .object({
  arms: z.array(
    z.object({
      build: z.string(),
      arm: z.string(),
      state: z.enum(['warm', 'cold']),
      summary: z.object({ medianMs: z.number(), minMs: z.number() }).strip().nullable(),
      failure: z.string().nullable(),
    }).strip(),
  ),
  })
  .strip();

/**
 * Read the arms a bar judges from a `perf arms` report.
 *
 * @param path - `<out>/arms-report.json`
 * @returns The arms, or why the file is not an arms report
 */
export function readBarReport(path: string): { readonly ok: true; readonly report: BarReport } | { readonly ok: false; readonly refusal: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (cause) {
    return { ok: false, refusal: `cannot read '${path}': ${cause instanceof Error ? cause.message : String(cause)}` };
  }
  const parsed = BarReportSchema.safeParse(raw);
  return parsed.success
    ? { ok: true, report: parsed.data }
    : { ok: false, refusal: `'${path}' is not a perf arms report: ${parsed.error.issues[0]?.message ?? 'invalid'}` };
}

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
export interface BarArm {
  readonly build: string;
  /** The arm's sequence name. */
  readonly arm: string;
  readonly state: CacheMode;
}

/** A parsed bar. */
export interface Bar {
  /** As written, for the report. */
  readonly text: string;
  readonly left: BarArm;
  readonly relation: BarRelation;
  readonly factor: number;
  readonly right: BarArm;
}

/** What a bar reads from an arms report: each arm's statistics, or why it has none. */
interface BarReport {
  readonly arms: readonly (BarArm & { readonly summary: BarSide | null; readonly failure: string | null })[];
}

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
  const holds = (a: number, b: number): boolean => (relation === '<=' ? a <= b * factor : a < b * factor);
  const median = holds(left.medianMs, right.medianMs);
  const min = holds(left.minMs, right.minMs);
  let verdict: BarJudgement['verdict'] = 'inconclusive';
  if (median && min) verdict = 'pass';
  else if (!median && !min) verdict = 'fail';
  return { verdict, median, min };
}

/** One arm, in the `--arm` spelling. */
const ARM = /^([\w.-]+):([\w-]+):(warm|cold)$/u;
/** A factor: digits and a decimal point only (`Number` refuses a second point). */
const FACTOR = /^[\d.]+$/u;

/**
 * @param text - One side of a bar
 * @returns The arm it names, or `null` when it is not `<build>:<sequence>:<warm|cold>`
 */
function parseBarArm(text: string): BarArm | null {
  const match = ARM.exec(text.trim());
  if (match === null) return null;
  const [, build = '', arm = '', state = ''] = match;
  return { build, arm, state: state as CacheMode };
}

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
  const left = parseBarArm(leftText);
  const right = parseBarArm(star === -1 ? rest : rest.slice(star + 1));
  if (left === null || right === null) return malformed;
  if (star === -1) return `--bar '${text}' names no factor — write 1* for "no slower"; a factor is never implied`;
  const factor = rest.slice(0, star).trim();
  const value = Number(factor);
  if (!FACTOR.test(factor) || !isFactor(value)) return `--bar '${text}': factor ${factor} is not a positive finite number`;
  return { text: text.trim(), left, relation, factor: value, right };
}

/**
 * Judge every bar against an arms report.
 *
 * @param report - `arms-report.json`, or anything carrying its arms
 * @param bars - The parsed bars
 * @returns One result per bar, or the refusal naming an arm the report does not hold
 */
export function judgeBars(
  report: BarReport,
  bars: readonly Bar[],
): { readonly ok: true; readonly results: readonly BarResult[] } | { readonly ok: false; readonly refusal: string } {
  const results: BarResult[] = [];
  for (const bar of bars) {
    const left = armOf(report, bar.left);
    const right = armOf(report, bar.right);
    if (typeof left === 'string') return { ok: false, refusal: `--bar '${bar.text}': ${left}` };
    if (typeof right === 'string') return { ok: false, refusal: `--bar '${bar.text}': ${right}` };
    if (left.summary !== null && right.summary !== null) {
      results.push({ bar, ...judgeBar(left.summary, bar.relation, right.summary, bar.factor), reason: null });
    } else {
      const unmeasured = left.summary === null ? left : right;
      const name = `${unmeasured.build} ${unmeasured.arm} ${unmeasured.state}`;
      const reason = `${name} has no measurement: ${unmeasured.failure ?? 'no repeats'}`;
      results.push({ bar, verdict: 'fail', median: false, min: false, reason });
    }
  }
  return { ok: true, results };
}

/**
 * One line per bar: its verdict, the bar, and which statistic held.
 *
 * @param results - What {@link judgeBars} returned
 * @returns The rendered lines
 */
export function renderBars(results: readonly BarResult[]): string {
  return results.map((result) => `${result.verdict.toUpperCase()}  ${result.bar.text}  (${detailOf(result)})`).join('\n');
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
 * @param report - The arms report
 * @param wanted - The arm a bar names
 * @returns The arm, or why there is none
 */
function armOf(report: BarReport, wanted: BarArm): BarReport['arms'][number] | string {
  const found = report.arms.find(
    (arm) => arm.build === wanted.build && arm.arm === wanted.arm && arm.state === wanted.state,
  );
  return found ?? `${wanted.build}:${wanted.arm}:${wanted.state} is not in the report`;
}

/**
 * @param factor - A candidate factor
 * @returns Whether it is a positive finite number
 */
function isFactor(factor: number): boolean {
  return Number.isFinite(factor) && factor > 0;
}
