/**
 * What every report records about each measured step's exit: the commitment it
 * was judged by (`ExitCommitment`) and the outcome — the `code` its
 * repetitions shared, or why there is none: the step was never reached, it
 * was killed every time, or the repetitions disagreed (and what each did). An
 * `observed` commitment admits more than one code, so without the code a
 * report could not say whether it timed a clean run or a run with findings —
 * the same command doing two different amounts of work.
 */

import { z } from 'zod';

import type { ExitCommitment } from './commands.js';
import type { SequenceResult } from './sequence.js';

/** What one repetition did with a step: exited a code, started and was killed, or never reached it. */
type RepetitionExit = number | 'killed' | 'not-run';

/** One step's exit, as a report records it. */
export type RecordedExit = {
  /** The step's name: a command's, or a sequence step's. */
  readonly step: string;
  readonly commitment: ExitCommitment;
} & (
  /** Every repetition ran the step and exited `code`. */
  | { readonly outcome: 'shared'; readonly code: number }
  /** No repetition reached the step: none were measured, or each stopped before it. */
  | { readonly outcome: 'not-run'; readonly code: null }
  /** Every repetition started the step and it was killed (a timeout, a signal, a full output buffer): it has no code. */
  | { readonly outcome: 'killed'; readonly code: null }
  /** The repetitions did different things; `seen` is each distinct one, in the order first met. */
  | { readonly outcome: 'disagreed'; readonly code: null; readonly seen: readonly RepetitionExit[] }
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
  z.object({ ...RECORDED_STEP, outcome: z.literal('killed'), code: z.null() }).strict(),
  z
    .object({
      ...RECORDED_STEP,
      outcome: z.literal('disagreed'),
      code: z.null(),
      seen: z.array(z.union([z.number().int(), z.literal('killed'), z.literal('not-run')])).min(2),
    })
    .strict(),
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
    const seen = [...new Set(results.map((result) => repetitionExit(result, step.name)))];
    const [only] = seen;
    if (seen.length > 1) return { ...recorded, outcome: 'disagreed', code: null, seen };
    if (only === undefined || only === 'not-run') return { ...recorded, outcome: 'not-run', code: null };
    return only === 'killed' ? { ...recorded, outcome: 'killed', code: null } : { ...recorded, outcome: 'shared', code: only };
  });
}

/**
 * @param result - One repetition
 * @param name - The step
 * @returns What that repetition did with it: a step it never reached is absent from its steps; one that ran and was killed has no code
 */
function repetitionExit(result: SequenceResult, name: string): RepetitionExit {
  const ran = result.steps.find((candidate) => candidate.name === name);
  if (ran === undefined) return 'not-run';
  return ran.exitCode ?? 'killed';
}
