/**
 * Deeply nested TypeScript for the `ts` job's pool tests: one statement per nesting kind, a depth
 * found at test time by doubling (the overflow depth is not stable even within one process, so no
 * test names one), and the job's call on a pool.
 */

import { DEFAULT_PARSE_LIMITS } from '../../src/parse-limits.js';
import type { ParsePool } from '../../src/parse-pool.js';
import type { TsRowsAnswer } from '../../src/projection/ts-extractor.js';
import type { TsVariant } from '../../src/schemas/projection-ts.js';

/** The limits a run's pool holds for what a document nests to: the configured stack and depth cap. */
export const CONFIGURED_NESTING = { stackMb: DEFAULT_PARSE_LIMITS.stackMb, outputDepth: DEFAULT_PARSE_LIMITS.outputDepth } as const;

/** How one file nests: what opens a level, what the innermost level holds, and what closes it. */
export interface Nesting {
  readonly variant: TsVariant;
  readonly open: string;
  readonly inner: string;
  readonly close: string;
}

/** Each bracket kind the pre-scan counts and a template substitution, which it counts too. */
export const BRACKET_NESTINGS: readonly Nesting[] = [
  { variant: 'ts', open: '(', inner: '1', close: ')' },
  { variant: 'ts', open: '[', inner: '', close: ']' },
  { variant: 'ts', open: '{k:', inner: '1', close: '}' },
  { variant: 'ts', open: '`${', inner: '1', close: '}`' },
];

/** JSX elements, which the pre-scan does not count. */
export const JSX_NESTING: Nesting = { variant: 'tsx', open: '<i>', inner: 'x', close: '</i>' };

/**
 * @param nesting - How the file nests
 * @param depth - Levels
 * @returns One statement nesting `depth` levels deep
 */
export function nested({ open, inner, close }: Nesting, depth: number): string {
  return `export const v = ${open.repeat(depth)}${inner}${close.repeat(depth)};\n`;
}

/**
 * @param pool - The pool
 * @param text - One file
 * @param variant - Its variant
 * @returns Its extraction on the pool
 */
export function tsOnPool(pool: ParsePool, text: string, variant: TsVariant = 'ts'): Promise<TsRowsAnswer> {
  return pool.tsRows(variant, text, Buffer.byteLength(text, 'utf8'));
}

/**
 * @param job - A pool job
 * @returns What it resolved to, or the error it rejected with
 */
export function settled(job: Promise<unknown>): Promise<unknown> {
  return job.then((value) => value, (error: unknown) => error);
}

/**
 * @param outcome - What a job settled to
 * @returns Whether it answered rows
 */
export function answeredRows(outcome: unknown): boolean {
  return typeof outcome === 'object' && outcome !== null && 'outcome' in outcome && outcome.outcome === 'rows';
}

/**
 * Double the depth from twice `outputDepth` until `answer` stops answering rows, never past the
 * input cap. Each depth waits on the last: whether to go deeper is the last answer's.
 *
 * @param answer - The pool's outcome at a depth: rows, or the error it was refused with
 * @param depth - The depth to try
 * @returns The first depth that was not rows, and what it settled to
 * @throws If no depth up to the input cap was refused: the parse no longer recurses on nesting
 */
export async function firstRefusal(
  answer: (depth: number) => Promise<unknown>,
  depth = DEFAULT_PARSE_LIMITS.outputDepth * 2,
): Promise<{ depth: number; outcome: unknown }> {
  if (depth * 8 > DEFAULT_PARSE_LIMITS.inputBytes) {
    throw new Error('no depth up to the input cap was refused: the parse no longer recurses on nesting, so these seeds prove nothing');
  }
  const outcome = await answer(depth);
  return answeredRows(outcome) ? firstRefusal(answer, depth * 2) : { depth, outcome };
}
