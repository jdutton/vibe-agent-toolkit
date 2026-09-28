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

import { type Verdict, VerdictSchema } from './extract.js';

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
  /** Layer 1: exit code plus the finding multiset; `null` for a row that did not run. */
  readonly verdict: Verdict | null;
  /** Layer 2: stdout after the one normalizer (`normalize.ts`). */
  readonly document: string;
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
          verdict: VerdictSchema.nullable(),
          document: z.string(),
        })
        .strict(),
    ),
  })
  .strict();
