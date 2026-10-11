/**
 * The document `vat skills validate` publishes, apart from the command.
 *
 * A sibling module because the published-shape registry imports it and the
 * command imports the writer that imports the registry: a schema declared in
 * the command module itself would be an import cycle, read before it is
 * initialised.
 *
 * 🔑 **One base, one meaning of `summary`.** `data.root` is the directory the
 * config was read from, stated once; every finding's `location` is relative to
 * it. `summary` — on the envelope and on a skill row — always counts FINDINGS
 * by severity; the number of skills validated is the envelope's `examined`.
 * Every finding is on the envelope, flat: a skill's own and the run's
 * (`ALLOW_UNUSED`), so a row is a tally, never a second list.
 */

import { FindingSchema, reportSchema, SeverityCountsSchema, type Report } from '@vibe-agent-toolkit/schema';
import { z } from 'zod';

import type { ExaminedDeclaration } from '../../utils/run-integrity.js';

/** What `examined` counts for `vat skills validate`, and the remedy when it is zero. */
export const SKILLS_VALIDATE_EXAMINED: ExaminedDeclaration = {
  unit: 'skills',
  whenZero: 'The run validated no skill, so it is not a verdict: the `skills.include` globs in'
    + ' vibe-agent-toolkit.config.yaml matched no SKILL.md (usually a typo in the glob, a renamed'
    + ' directory, or a `skills.exclude` that swallows every match), or the config declares no `skills:` block. Fix the patterns so they discover the skills this'
    + ' project ships; stderr names the globs this run used.',
};

/** One validated skill — every one, clean or not. */
const SkillRowSchema = z.object({
  /** The skill's name, as discovery read it from its frontmatter. */
  name: z.string(),
  status: z.enum(['ok', 'findings']),
  /** The findings this skill published, by severity. */
  summary: SeverityCountsSchema,
  /** Findings `validation.allow` suppressed for this skill — a count, never published as findings. */
  allowed: z.number().int().nonnegative(),
}).strict();

const SkillsValidateDataSchema = z.object({
  /** The directory the config was read from — the ONE base every finding `location` is relative to. */
  root: z.string(),
  /** One row per skill validated, in validation order. */
  skills: z.array(SkillRowSchema),
}).strict();

export type SkillsValidateData = z.infer<typeof SkillsValidateDataSchema>;

/** The document this command publishes. */
export const SKILLS_VALIDATE_REPORT_SCHEMA = reportSchema(SkillsValidateDataSchema, FindingSchema);

export type SkillsValidateReport = Report<SkillsValidateData>;
