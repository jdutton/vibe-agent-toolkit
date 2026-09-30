/**
 * The document `vat skills package` publishes, apart from the command.
 *
 * A sibling module because the published-shape registry imports it and the
 * command imports the writer that imports the registry (the cycle
 * `report-schemas.ts` describes).
 *
 * `examined` is the one skill the run was pointed at. Every finding the
 * validation gate produced is on the envelope, located as the validator
 * located it; a claude.ai ZIP over its 8 MB ceiling adds
 * `SKILL_PACKAGE_TOO_LARGE`, located at the skill's `SKILL.md`.
 */

import { FindingSchema, reportSchema } from '@vibe-agent-toolkit/schema';
import { z } from 'zod';

import type { ExaminedDeclaration } from '../../utils/run-integrity.js';

/** What `examined` counts for `vat skills package`, and the remedy when it is zero. */
export const SKILLS_PACKAGE_EXAMINED: ExaminedDeclaration = {
  unit: 'skills',
  whenZero: 'Point the command at the SKILL.md file of the skill to package.',
};

const SkillsPackageDataSchema = z.object({
  /** The skill's name: its frontmatter `name`, else its H1, else its directory. */
  skill: z.string(),
  /** The frontmatter `version`, or `null` when the skill declares none or packaging never read it. */
  version: z.string().nullable(),
  /** The packaged skill directory, or `null` when the validation gate stopped the run before packaging. */
  outputPath: z.string().nullable(),
  /** `true` for `--dry-run`: `outputPath` is where the package WOULD go, and nothing was written. */
  dryRun: z.boolean(),
}).strict();

export type SkillsPackageData = z.infer<typeof SkillsPackageDataSchema>;

/** The document this command publishes. */
export const SKILLS_PACKAGE_REPORT_SCHEMA = reportSchema(SkillsPackageDataSchema, FindingSchema);
