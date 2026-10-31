/**
 * What every report records about each measured step's exit: the commitment it
 * was judged by (`ExitCommitment`) and the outcome — the `code` its
 * repetitions shared, or why there is none: the step never ran, or the
 * repetitions disagreed. An `observed` commitment admits more than one code,
 * so without the code a report could not say whether it timed a clean run or
 * a run with findings — the same command doing two different amounts of work.
 */

import { z } from 'zod';

import type { ExitCommitment } from './commands.js';
import type { SequenceResult } from './sequence.js';

/** One step's exit, as a report records it. */
export type RecordedExit = {
  /** The step's name: a command's, or a sequence step's. */
  readonly step: string;
  readonly commitment: ExitCommitment;
} & (
  /** Every repetition ran the step and exited `code`. */
  | { readonly outcome: 'shared'; readonly code: number }
  /** No repetition ran the step: none were measured, or each stopped before it. */
  | { readonly outcome: 'not-run'; readonly code: null }
  /** The repetitions exited different codes, or only some of them ran the step. */
  | { readonly outcome: 'disagreed'; readonly code: null }
);

/** Runtime schema for {@link ExitCommitment}. */
const ExitCommitmentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('exact'), code: z.number().int() }).strict(),
  z.object({ kind: z.literal('observed'), completed: z.array(z.number().int()).min(1) }).strict(),
]) satisfies z.ZodType<ExitCommitment>;

const RECORDED_STEP = { step: z.string().min(1), commitment: ExitCommitmentSchema };

/** Runtime schema for {@link RecordedExit}. */
export const RecordedExitSchema = z.discriminatedUnion('outcome', [
  z.object({ ...RECORDED_STEP, outcome: z.literal('shared'), code: z.number().int() }).strict(),
  z.object({ ...RECORDED_STEP, outcome: z.literal('not-run'), code: z.null() }).strict(),
  z.object({ ...RECORDED_STEP, outcome: z.literal('disagreed'), code: z.null() }).strict(),
]) satisfies z.ZodType<RecordedExit>;

/**
 * @param steps - The steps that were measured, each with its commitment
 * @param results - Every measured repetition
 * @returns One record per step, in order
 */
export function recordExits(
  steps: readonly { readonly name: string; readonly exit: ExitCommitment }[],
  results: readonly SequenceResult[],
): RecordedExit[] {
  return steps.map((step) => {
    const recorded = { step: step.name, commitment: step.exit };
    const codes = new Set(results.map((result) => result.steps.find((ran) => ran.name === step.name)?.exitCode ?? null));
    const [only] = codes;
    if (codes.size > 1) return { ...recorded, outcome: 'disagreed', code: null };
    return only === undefined || only === null ? { ...recorded, outcome: 'not-run', code: null } : { ...recorded, outcome: 'shared', code: only };
  });
}
