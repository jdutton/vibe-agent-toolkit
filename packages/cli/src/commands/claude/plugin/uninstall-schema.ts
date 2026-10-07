/**
 * The document `vat claude plugin uninstall` publishes, apart from the command.
 *
 * A sibling module because the published-shape registry imports it and the
 * command imports the writer that imports the registry (the cycle
 * `report-schemas.ts` describes).
 *
 * `examined` counts uninstall requests — one per run, a key or `--all`. Nothing
 * to remove is an answer (`plugins` lists `removed: false`, or is empty under
 * `--all`), not a run that looked at nothing. A plugin whose directory was on
 * disk with no registry entry, or whose directory is another registered
 * plugin's on disk (kept), is a `PLUGIN_UNINSTALL_INCOMPLETE` finding located
 * at its key.
 */

import { FindingSchema, reportSchema, type Report } from '@vibe-agent-toolkit/schema';
import { z } from 'zod';

import type { ExaminedDeclaration } from '../../../utils/run-integrity.js';

/** What `examined` counts for `vat claude plugin uninstall`, and the remedy when it is zero. */
export const PLUGIN_UNINSTALL_EXAMINED: ExaminedDeclaration = {
  unit: 'uninstall requests',
  whenZero: 'No uninstall request was read — pass <plugin@marketplace>, or --all from the npm package directory.',
};

const PluginUninstallDataSchema = z.object({
  dryRun: z.boolean(),
  plugins: z.array(z.object({ key: z.string(), removed: z.boolean() }).strict()),
}).strict();

export type PluginUninstallData = z.infer<typeof PluginUninstallDataSchema>;

/** The document this command publishes. */
export const PLUGIN_UNINSTALL_REPORT_SCHEMA = reportSchema(PluginUninstallDataSchema, FindingSchema);

export type PluginUninstallReport = Report<PluginUninstallData>;
