/**
 * The document `vat doctor` publishes, apart from the command.
 *
 * A sibling module because the published-shape registry imports it and the
 * command imports the writer that imports the registry (the cycle
 * `report-schemas.ts` describes).
 *
 * `examined` counts the checks run. Each check is a row of `data.checks`; a
 * `fail` is also a `DOCTOR_CHECK_FAILED` finding (error, exit 1) and an
 * `undetermined` one a `DOCTOR_CHECK_WARNED` finding (warning — nothing was
 * verified, which is not health, but not a failure either). `pass` and
 * `skipped` are rows only.
 */

import { FindingSchema, reportSchema } from '@vibe-agent-toolkit/schema';
import { z } from 'zod';

import type { ExaminedDeclaration } from '../utils/run-integrity.js';

/**
 * What a check can conclude — the one list `DoctorOutcome` is derived from, so
 * the published enum and the checks' vocabulary cannot drift apart.
 */
export const DOCTOR_OUTCOMES = ['pass', 'fail', 'undetermined', 'skipped'] as const;

/**
 * What a single check concluded.
 *
 * Four values, because a check has four possible answers and a boolean has two.
 * `passed: boolean` forced "I could not tell" and "it does not apply" to be
 * spelled as `true` — the reassuring value — so a swallowed EACCES and a healthy
 * build rendered identically, both as `✅`, and both counted toward
 * "7/7 checks passed".
 *
 * - `pass`         — the check ran and the thing is fine.
 * - `fail`         — the check ran and the thing is wrong: a `DOCTOR_CHECK_FAILED`
 *                    finding, the only outcome that affects the exit code.
 * - `undetermined` — the check could not reach an answer (network down, file
 *                    unreadable). NOT a pass: nothing was verified. A
 *                    `DOCTOR_CHECK_WARNED` finding.
 * - `skipped`      — the check does not apply here (e.g. a VAT-source-tree-only
 *                    check outside the source tree). Determinate, but not a pass.
 */
export type DoctorOutcome = (typeof DOCTOR_OUTCOMES)[number];

/** What `examined` counts for `vat doctor`, and the remedy when it is zero. */
export const DOCTOR_EXAMINED: ExaminedDeclaration = {
  unit: 'checks',
  whenZero: 'Doctor ran no check at all, which is a defect in VAT — report it with the output of vat doctor --debug.',
};

const DoctorCheckSchema = z.object({
  name: z.string(),
  outcome: z.enum(DOCTOR_OUTCOMES),
  message: z.string(),
  suggestion: z.string().optional(),
}).strict();

const DoctorDataSchema = z.object({
  /** The working directory doctor ran from — what the checks and the project context are relative to. */
  currentDir: z.string(),
  /** The project root found from the working directory, or `null` outside any project. */
  projectRoot: z.string().nullable(),
  /** The `vibe-agent-toolkit.config.yaml` found from the working directory, or `null`. */
  configPath: z.string().nullable(),
  /** Every check that ran, in run order — the concise stderr view's filter never applies here. */
  checks: z.array(DoctorCheckSchema),
}).strict();

/** Result of a single doctor check — one row of `data.checks`. */
export type DoctorCheckResult = z.infer<typeof DoctorCheckSchema>;

export type DoctorData = z.infer<typeof DoctorDataSchema>;

/** The document this command publishes. */
export const DOCTOR_REPORT_SCHEMA = reportSchema(DoctorDataSchema, FindingSchema);
