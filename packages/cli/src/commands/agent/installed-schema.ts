/**
 * The document `vat agent installed` publishes, apart from the command.
 *
 * A sibling module because the published-shape registry imports it and the
 * command imports the writer that imports the registry (the cycle
 * `report-schemas.ts` describes).
 *
 * `examined` counts the scopes scanned. A scope whose directory is absent is
 * scanned and empty; one the OS will not list is a `SCAN_PATH_UNREADABLE`
 * warning finding at that directory — the listing is then a floor, not the
 * answer — and the other scopes are still listed.
 */

import { FindingSchema, reportSchema, type Report } from '@vibe-agent-toolkit/schema';
import { z } from 'zod';

import type { ExaminedDeclaration } from '../../utils/run-integrity.js';

/** What `examined` counts for `vat agent installed`, and the remedy when it is zero. */
export const AGENT_INSTALLED_EXAMINED: ExaminedDeclaration = {
  unit: 'scopes scanned',
  whenZero: 'No install scope was scanned, which is a defect in VAT — report it with the output of vat agent installed --debug.',
};

const AgentInstalledDataSchema = z.object({
  /** The scopes scanned, in scan order. */
  scanned: z.array(z.string()),
  skills: z.array(z.object({
    /** The installed skill's directory name. */
    name: z.string(),
    /** The scope it was found in. */
    scope: z.string(),
    /** `symlink` for a `--dev` install, `directory` for a copied one. */
    type: z.enum(['symlink', 'directory']),
    /** Where it is installed. */
    path: z.string(),
  }).strict()),
}).strict();

export type AgentInstalledData = z.infer<typeof AgentInstalledDataSchema>;

/** The document this command publishes. */
export const AGENT_INSTALLED_REPORT_SCHEMA = reportSchema(AgentInstalledDataSchema, FindingSchema);

export type AgentInstalledReport = Report<AgentInstalledData>;
