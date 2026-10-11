/**
 * The document `vat skill test run` publishes, apart from the command.
 *
 * A sibling module because the published-shape registry imports it and the
 * command imports the writer that imports the registry (the cycle
 * `report-schemas.ts` describes).
 *
 * `examined` counts the evals the run graded — or, on `--dry-run`, which grades
 * nothing, the evals it staged. Each failed eval is a `SKILL_TEST_EVAL_FAILED`
 * finding at the suite's `evals.json` (`field`: the eval id); a harness that could not run is the
 * envelope's error branch, its `error.code` decided where the cause was seen.
 */

import { FindingSchema, reportSchema } from '@vibe-agent-toolkit/schema';
import { z } from 'zod';

import type { ExaminedDeclaration } from '../../../utils/run-integrity.js';

/** What `examined` counts for `vat skill test run`, and the remedy when it is zero. */
export const SKILL_TEST_RUN_EXAMINED: ExaminedDeclaration = {
  unit: 'evals',
  whenZero: "Declare at least one eval in the skill's evals.json (or the suite --evals names).",
};

const SkillTestRunDataSchema = z.object({
  /** The skill reference as passed — a declared name or a path. */
  skill: z.string(),
  /** The harness's human verdict line (`PASS 3/3`, the dry-run preview), also on stderr as `Summary:`. */
  description: z.string(),
  /** Every eval the run graded, with its composite verdict (output expectations and tool verdict). */
  evals: z.array(z.object({ id: z.string(), passed: z.boolean() }).strict()),
  artifacts: z.object({
    /** The `friction.json` the run wrote, or `null` when it wrote none (a dry run). */
    frictionReport: z.string().nullable(),
    /** The harness root (`--out`). On a default run only its `results/` child survives. */
    outputDir: z.string(),
  }).strict(),
}).strict();

/** The document this command publishes. */
export const SKILL_TEST_RUN_REPORT_SCHEMA = reportSchema(SkillTestRunDataSchema, FindingSchema);
