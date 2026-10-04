/**
 * The verdict facet's report body: per subject, every verb's verdict and its
 * normalized document.
 *
 * One envelope per subject alias (`coordinate.subject.id` is the alias), so the
 * lab's existing axis rules — subject, subject version, instrument — apply to a
 * verdict pair exactly as to any other facet's.
 */

import { z } from 'zod';

import type { ArmEnvironment } from '../../harness/arm-env.js';


/** The facet name every verdict envelope carries. */
export const VERDICT_FACET = 'verdict';

/** One vat invocation's result. */
export interface VerdictRow {
  /** The row name — a verb, or `resources-query:<file>` (see `verbs.ts`). */
  readonly name: string;
  readonly argv: readonly string[];
  /** `not-run` when the process never produced an exit code (spawn error, timeout kill). */
  readonly outcome: 'exited' | 'not-run';
  readonly exitCode: number | null;
  readonly spawnError: string | null;
  /**
   * Layer 2: stdout after the one normalizer (`normalize.ts`). Layer 1 is derived
   * from it at compare time (`rowVerdict`), never stored: a stored one freezes the capturing build's extractor.
   */
  readonly document: string;
}

/**
 * A verb the subjects file says this subject cannot complete, and why
 * (`unmeasurableBuildVerbs`). It still ran — its row is in `rows` — and a
 * compare checks the claim: the row refused at exit 2 in both arms.
 */
export interface VerdictExclusion {
  readonly name: string;
  readonly reason: string;
}

/** One subject's capture under one arm. */
export interface VerdictBody {
  /**
   * The environment that DISTINGUISHES this arm — the caller's `--env`/`--unset`.
   *
   * The lab also imposes, on every arm alike, a private projection store under
   * `--out` (`VAT_PROJECTION_STORE_DIR`) and an unset `CLAUDE_CONFIG_DIR`; those
   * are not recorded here, because the store path differs between any two
   * captures by construction, and recording it would make every pair of arms
   * distinguishable — the indistinguishable-arms refusal could never fire.
   */
  readonly arm: ArmEnvironment;
  readonly rows: readonly VerdictRow[];
  /**
   * Verbs the subjects file says cannot be measured for this subject. Each names
   * exactly one row of `rows`: the verb ran, and what it did is the evidence the
   * compare judges the exclusion by.
   */
  readonly excluded: readonly VerdictExclusion[];
}

/** Runtime schema for {@link VerdictBody}, for reading a stored envelope back. */
export const VerdictBodySchema: z.ZodType<VerdictBody> = z
  .object({
    arm: z
      .object({
        set: z.record(z.string(), z.string()),
        unset: z.array(z.string()),
      })
      .strict(),
    rows: z.array(
      z
        .object({
          name: z.string().min(1),
          argv: z.array(z.string()),
          outcome: z.enum(['exited', 'not-run']),
          exitCode: z.number().int().nullable(),
          spawnError: z.string().nullable(),
          document: z.string(),
        })
        .strict(),
    ),
    excluded: z.array(z.object({ name: z.string().min(1), reason: z.string().min(1) }).strict()),
  })
  .strict()
  .superRefine((body, ctx) => {
    // The two captures are matched row to row BY NAME, so a name names one row.
    for (const [index, row] of body.rows.entries()) {
      if (body.rows.findIndex((other) => other.name === row.name) === index) continue;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rows', index, 'name'],
        message: `two rows are named '${row.name}'; a row name is what the two captures are matched by`,
      });
    }
  })
  .superRefine((body, ctx) => {
    // An exclusion with no row would be a verb nobody ran and nobody can check —
    // exactly the hidden row an exclusion must never become.
    for (const [index, exclusion] of body.excluded.entries()) {
      const rows = body.rows.filter((row) => row.name === exclusion.name).length;
      const repeated = body.excluded.findIndex((other) => other.name === exclusion.name) !== index;
      if (rows === 1 && !repeated) continue;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['excluded', index, 'name'],
        message: repeated
          ? `verb '${exclusion.name}' is excluded twice`
          : `excluded verb '${exclusion.name}' names ${String(rows)} row(s); an excluded verb still runs, and has exactly one`,
      });
    }
  });
