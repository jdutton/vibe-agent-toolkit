/**
 * The document `vat claude plugin install` publishes, apart from the command.
 *
 * A sibling module because the published-shape registry imports it and the
 * command imports the writer that imports the registry (the cycle
 * `report-schemas.ts` describes).
 *
 * `examined` counts install sources resolved — one per run, the
 * `--npm-postinstall` lane included. A postinstall that skips (not a global
 * install, no plugin tree) resolved its source and installed nothing: `ok`
 * with `skills: []`, never a failure inside `npm install -g`.
 */

import { FindingSchema, reportSchema, type Report } from '@vibe-agent-toolkit/schema';
import { z } from 'zod';

import type { ExaminedDeclaration } from '../../../utils/run-integrity.js';

/** What `examined` counts for `vat claude plugin install`, and the remedy when it is zero. */
export const PLUGIN_INSTALL_EXAMINED: ExaminedDeclaration = {
  unit: 'install sources',
  whenZero: 'No install source was resolved — pass npm:<package>, a directory, a .zip or .tgz, or --dev from a built project.',
};

const PluginInstallDataSchema = z.object({
  /** The source as resolved: `npm:<pkg>`, `local:<dir>`, an archive path, the dev package, or the postinstall directory. */
  source: z.string(),
  sourceType: z.string(),
  dryRun: z.boolean(),
  /** `true` for `--dev`: each skill is a link to its build, not a copy. */
  symlink: z.boolean(),
  skills: z.array(z.object({
    name: z.string(),
    installPath: z.string(),
    /** The build a `--dev` link points at; `null` for a copy. */
    sourcePath: z.string().nullable(),
  }).strict()),
}).strict();

export type PluginInstallData = z.infer<typeof PluginInstallDataSchema>;

/** The document this command publishes. */
export const PLUGIN_INSTALL_REPORT_SCHEMA = reportSchema(PluginInstallDataSchema, FindingSchema);

export type PluginInstallReport = Report<PluginInstallData>;
