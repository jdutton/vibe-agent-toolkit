/**
 * Reading a `perf arms` report back: the one reader `perf bars` and
 * `verdict union` judge over, and the one spelling of an arm they name.
 *
 * `.strip()` on purpose: a reader whitelists what its judges read — the
 * prepared clone, the inputs that decided the numbers, every build and the
 * load, each arm's identity, summary, failure and every repetition's exits and
 * violation — rather than re-declaring the arms facet's whole record (step
 * stderr, removed names, timings per step).
 *
 * ## A judged arm is a complete one
 *
 * {@link incompleteArm} is the one test both judges apply before reading an
 * arm's rounds: an arm that failed, a repetition that broke its rule, or fewer
 * than {@link MIN_JUDGED_REPETITIONS} repetitions is not a measurement either
 * judge may read as one.
 */

import { readFileSync } from 'node:fs';

import { z } from 'zod';

import { InstrumentVersionSchema } from '../../envelope/coordinate.js';
import { recaptureRefusal } from '../../harness/dumps.js';
import { LoadReadingsSchema } from '../../harness/schemas.js';
import type { CacheMode } from '../../harness/types.js';

const RepetitionSchema = z
  .object({
    exitCode: z.number().int().nullable(),
    violation: z.string().nullable(),
    steps: z.array(z.object({ name: z.string(), timed: z.boolean(), exitCode: z.number().int().nullable() }).strip()),
  })
  .strip();

/**
 * Everything the caller chose that decided the report's numbers: the arm
 * environment, every committed exit, the untimed prerequisites run before round
 * 1, and the per-step timeout.
 */
const ArmsInputsSchema = z
  .object({
    env: z.object({ set: z.record(z.string(), z.string()), unset: z.array(z.string()) }).strict(),
    expectedExits: z.array(
      z.object({ build: z.string(), sequence: z.string(), step: z.string(), exit: z.number().int() }).strict(),
    ),
    prerequisites: z.array(z.string()),
    timeoutMs: z.number().int().positive().nullable(),
  })
  .strict();

/** What {@link ArmsInputsSchema} records. */
export type ArmsInputs = z.infer<typeof ArmsInputsSchema>;

const ArmsReportFileSchema = z
  .object({
    prepared: z.object({ ok: z.literal(true), path: z.string().min(1), commit: z.string().min(1) }).strip(),
    inputs: ArmsInputsSchema,
    builds: z.array(
      z
        .object({
          alias: z.string(),
          source: z.discriminatedUnion('kind', [
            z.object({ kind: z.literal('tree'), path: z.string() }).strict(),
            z.object({ kind: z.literal('dist'), path: z.string() }).strict(),
            z.object({ kind: z.literal('npx'), spec: z.string() }).strict(),
          ]),
          instrument: InstrumentVersionSchema,
        })
        .strip(),
    ),
    load: LoadReadingsSchema,
    arms: z.array(
      z
        .object({
          build: z.string(),
          arm: z.string(),
          state: z.enum(['warm', 'cold']),
          repetitions: z.array(RepetitionSchema),
          summary: z.object({ medianMs: z.number(), minMs: z.number() }).strip().nullable(),
          failure: z.string().nullable(),
        })
        .strip(),
    ),
  })
  .strip();

/** What a judge reads from `arms-report.json`. */
export type ArmsReportFile = z.infer<typeof ArmsReportFileSchema>;

/**
 * Read a `perf arms` report.
 *
 * @param path - `<out>/arms-report.json`
 * @returns The report, or why the file is not an arms report
 */
export function readArmsReportFile(
  path: string,
): { readonly ok: true; readonly report: ArmsReportFile } | { readonly ok: false; readonly refusal: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (cause) {
    return { ok: false, refusal: `REFUSED: cannot read '${path}': ${cause instanceof Error ? cause.message : String(cause)}` };
  }
  const parsed = ArmsReportFileSchema.safeParse(raw);
  return parsed.success
    ? { ok: true, report: parsed.data }
    : { ok: false, refusal: recaptureRefusal(`'${path}'`, parsed.error) };
}

/** One arm of an arms report, as a judge names it. */
export interface ArmName {
  readonly build: string;
  /** The arm's sequence name. */
  readonly arm: string;
  readonly state: CacheMode;
}

/** One arm, in the `--arm` spelling. */
const ARM = /^([\w.-]+):([\w-]+):(warm|cold)$/u;

/**
 * @param text - An arm in `--arm` spelling
 * @returns The arm it names, or `null` when it is not `<build>:<sequence>:<warm|cold>`
 */
export function parseArmName(text: string): ArmName | null {
  const match = ARM.exec(text.trim());
  if (match === null) return null;
  const [, build = '', arm = '', state = ''] = match;
  return { build, arm, state: state as CacheMode };
}

/**
 * @param arm - An arm
 * @returns Its `--arm` spelling
 */
export function armName(arm: ArmName): string {
  return `${arm.build}:${arm.arm}:${arm.state}`;
}

/**
 * @param arms - A report's arms
 * @param wanted - The arm a judge names
 * @returns The arm, or why there is none
 */
export function findArm<T extends ArmName>(arms: readonly T[], wanted: ArmName): T | string {
  const found = arms.find((arm) => arm.build === wanted.build && arm.arm === wanted.arm && arm.state === wanted.state);
  return found ?? `${armName(wanted)} is not in the report`;
}

/** The fewest repetitions a judge reads as a measurement — `perf arms --rounds`' own floor. */
const MIN_JUDGED_REPETITIONS = 5;

/** What {@link incompleteArm} reads of an arm. */
type CompletenessEvidence = ArmName & {
  readonly failure: string | null;
  readonly repetitions: readonly { readonly violation: string | null }[];
};

/**
 * The one completeness test — see this module's header.
 *
 * @param arm - An arm of an arms report
 * @returns Why its rounds are not a complete measurement, or `null`
 */
export function incompleteArm(arm: CompletenessEvidence): string | null {
  const name = armName(arm);
  if (arm.failure !== null) return `${name} failed: ${arm.failure}`;
  const broken = arm.repetitions.findIndex((repetition) => repetition.violation !== null);
  if (broken !== -1) {
    return `${name} repetition ${String(broken + 1)} broke its rule: ${arm.repetitions[broken]?.violation ?? ''}`;
  }
  if (arm.repetitions.length < MIN_JUDGED_REPETITIONS) {
    return `${name} has ${String(arm.repetitions.length)} repetition(s); a judged arm needs at least ${String(MIN_JUDGED_REPETITIONS)}`;
  }
  return null;
}
