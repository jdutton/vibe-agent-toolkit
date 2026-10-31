/**
 * What every report records about each measured step's exit: the commitment it
 * was judged by (`ExitCommitment`) and the code its repetitions shared. An
 * `observed` commitment admits more than one code, so without the code it
 * observed a report could not say whether it timed a clean run or a run with
 * findings — the same command doing two different amounts of work.
 */

import { z } from 'zod';

import type { ExitCommitment } from './commands.js';
import type { SequenceResult } from './sequence.js';

/** One step's exit, as a report records it. */
export interface RecordedExit {
  /** The step's name: a command's, or a sequence step's. */
  readonly step: string;
  readonly commitment: ExitCommitment;
  /** The code every repetition exited with, or `null` when none ran or they differed. */
  readonly observed: number | null;
}

/** Runtime schema for {@link ExitCommitment}. */
const ExitCommitmentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('exact'), code: z.number().int() }).strict(),
  z.object({ kind: z.literal('observed'), completed: z.array(z.number().int()).min(1) }).strict(),
]) satisfies z.ZodType<ExitCommitment>;

/** Runtime schema for {@link RecordedExit}. */
export const RecordedExitSchema = z
  .object({ step: z.string().min(1), commitment: ExitCommitmentSchema, observed: z.number().int().nullable() })
  .strict() satisfies z.ZodType<RecordedExit>;

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
    const codes = new Set(results.map((result) => result.steps.find((ran) => ran.name === step.name)?.exitCode ?? null));
    const [only] = codes;
    return { step: step.name, commitment: step.exit, observed: codes.size === 1 && only !== undefined ? only : null };
  });
}
