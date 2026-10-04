/**
 * The document `vat skills build` publishes, apart from the command.
 *
 * A sibling module because the published-shape registry imports it and the
 * command imports the writer that imports the registry (the cycle
 * `report-schemas.ts` describes).
 *
 * `examined` counts the skills the run discovered, after `--skill` — the ones
 * `publish: false` set aside included, and a dry run's included. Every finding
 * is on the envelope, flat: a skill's own (pre-build, packaging, post-build)
 * and the run's (`ALLOW_UNUSED`); a row names its status, never a second list.
 *
 * Every path — `skills[].source`, `skills[].output` and every finding's
 * `location` — is relative to the directory holding
 * `vibe-agent-toolkit.config.yaml`, the root whose config the build read, the
 * same base `vat claude plugin build` uses.
 */

import { FindingSchema, reportSchema } from '@vibe-agent-toolkit/schema';
import { z } from 'zod';

import type { ExaminedDeclaration } from '../../utils/run-integrity.js';

/** What `examined` counts for `vat skills build`, and the remedy when it is zero. */
export const SKILLS_BUILD_EXAMINED: ExaminedDeclaration = {
  unit: 'skills',
  whenZero: 'The run built no skill, so it is not a verdict: the config declares no `skills:` block, or its'
    + ' `skills.include` globs matched no SKILL.md (usually a typo in the glob, a renamed directory, or a'
    + ' `skills.exclude` that swallows every match). Fix the patterns so they discover the skills this project ships.',
};

const SkillsBuildDataSchema = z.object({
  dryRun: z.boolean(),
  /** `false` on a dry run, and on a run refused before validating: nothing was validated. */
  validated: z.boolean(),
  skillsBuilt: z.number().int().nonnegative(),
  /** Skills whose content the packager refused — no bundle exists for them. */
  skillsFailed: z.number().int().nonnegative(),
  /** Skills the PRE-build source validation rejected — packaging never ran for them. */
  skillsFailedValidation: z.number().int().nonnegative(),
  /** `publish: false` skills this run set aside unbuilt (validated at source by `vat validate`). */
  skillsInPlace: z.array(z.string()),
  /** Plugin-local `publish: false` skills: set aside here, shipped with their plugin by the claude phase. */
  skillsPluginOnly: z.array(z.string()),
  /** Whether `dist/skills` was REPLACED by this run; `false` leaves the previous output untouched. */
  outputCommitted: z.boolean(),
  /** Present only when the promotion/discard step itself failed: what is on disk and how to recover it. */
  promotionError: z.string().optional(),
  skills: z.array(z.object({
    name: z.string(),
    source: z.string(),
    /** Where the bundle lands once the run earns the swap — on disk only when `outputCommitted`. */
    output: z.string(),
    status: z.enum(['ok', 'findings']),
  }).strict()),
}).strict();

export type SkillsBuildData = z.infer<typeof SkillsBuildDataSchema>;

/** The document this command publishes. */
export const SKILLS_BUILD_REPORT_SCHEMA = reportSchema(SkillsBuildDataSchema, FindingSchema);
