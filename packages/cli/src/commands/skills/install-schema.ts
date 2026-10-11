/**
 * The document `vat skills install` publishes, apart from the command.
 *
 * A sibling module because the published-shape registry imports it and the
 * command imports the writer that imports the registry (the cycle
 * `report-schemas.ts` describes).
 *
 * `examined` counts the skills in the install plan — every skill the source
 * holds, each validated before anything is written. A skill that fails its
 * validation is an error finding and the whole batch installs nothing.
 */

import { FindingSchema, reportSchema, type Report } from '@vibe-agent-toolkit/schema';
import { z } from 'zod';

import type { ExaminedDeclaration } from '../../utils/run-integrity.js';

/**
 * What `examined` counts for `vat skills install`, and the remedy when it is zero.
 *
 * ⚠️ `whenZero` never fires for this verb: a source holding no skill refuses
 * (`USAGE_INVALID`, "No SKILL.md found") before anything is counted, so a
 * completed report always examined at least one. It stays because every
 * `report` entry must declare one, and it says so rather than naming a remedy
 * for a run that cannot happen.
 */
export const SKILLS_INSTALL_EXAMINED: ExaminedDeclaration = {
  unit: 'skills',
  whenZero: 'Unreachable: a source holding no skill is refused (USAGE_INVALID) before any skill is counted.',
};

const SkillsInstallDataSchema = z.object({
  /** `npm:<pkg>` as typed, otherwise the resolved source path. */
  source: z.string(),
  target: z.string(),
  scope: z.string(),
  /** `true` for `--dry-run`: the plan, with nothing written. */
  dryRun: z.boolean(),
  /** Installed (or, under `--dry-run`, planned); empty when validation stopped the batch. */
  skills: z.array(z.object({
    name: z.string(),
    installPath: z.string(),
    /** `--dry-run` only: something is already at `installPath`, which the run replaces (only under `--force`: without it the plan is refused). */
    alreadyInstalled: z.boolean().optional(),
  }).strict()),
}).strict();

export type SkillsInstallData = z.infer<typeof SkillsInstallDataSchema>;

/** The document this command publishes. */
export const SKILLS_INSTALL_REPORT_SCHEMA = reportSchema(SkillsInstallDataSchema, FindingSchema);

export type SkillsInstallReport = Report<SkillsInstallData>;
