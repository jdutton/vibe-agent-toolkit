/**
 * The document `vat skills list` publishes, apart from the command.
 *
 * A sibling module because the published-shape registry imports it and the
 * command imports the writer that imports the registry (the cycle
 * `report-schemas.ts` describes).
 *
 * `examined` counts the search roots scanned: the project directory (or the
 * extracted package's `dist/skills/`) is one; `--user` scans two, Claude's
 * `plugins/` and `skills/` directories, and an absent one is scanned and empty.
 * A directory the scan could not list is a `SCAN_PATH_UNREADABLE` warning
 * finding — the listing is then a floor, not the answer.
 */

import { FindingSchema, reportSchema, type Report } from '@vibe-agent-toolkit/schema';
import { z } from 'zod';

import type { ExaminedDeclaration } from '../../utils/run-integrity.js';

/** What `examined` counts for `vat skills list`, and the remedy when it is zero. */
export const SKILLS_LIST_EXAMINED: ExaminedDeclaration = {
  unit: 'search roots',
  whenZero: 'No search root was scanned — pass a project directory, an npm: or .tgz source, or --user.',
};

const SkillsListDataSchema = z.object({
  /** The one absolute path in the document; every `skills[].path` is relative to it. */
  root: z.string(),
  /** `project`, `user`, or `npm` (an npm: or .tgz source inspected without installing). */
  context: z.string(),
  skills: z.array(z.object({
    /** The name the skill's frontmatter declares — what `vat skills install` installs it as. */
    name: z.string(),
    path: z.string(),
    /** `false` for a non-standard filename (`skill.md`, `Skill.md`); `warning` says which. */
    valid: z.boolean(),
    warning: z.string().optional(),
  }).strict()),
}).strict();

export type SkillsListData = z.infer<typeof SkillsListDataSchema>;

/** The document this command publishes. */
export const SKILLS_LIST_REPORT_SCHEMA = reportSchema(SkillsListDataSchema, FindingSchema);

export type SkillsListReport = Report<SkillsListData>;
