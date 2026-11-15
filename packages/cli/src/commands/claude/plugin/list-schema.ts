/**
 * The document `vat claude plugin list` publishes, apart from the command.
 *
 * A sibling module because the published-shape registry imports it and the
 * command imports the writer that imports the registry (the cycle
 * `report-schemas.ts` describes).
 *
 * `examined` counts the two registries consulted — the plugin registry and the
 * legacy skills directory. An absent one is consulted and empty, so a fresh
 * machine is `ok` with nothing listed; one the OS refuses ends the run.
 */

import { FindingSchema, reportSchema, type Report } from '@vibe-agent-toolkit/schema';
import { z } from 'zod';

import type { ExaminedDeclaration } from '../../../utils/run-integrity.js';

/** What `examined` counts for `vat claude plugin list`, and the remedy when it is zero. */
export const PLUGIN_LIST_EXAMINED: ExaminedDeclaration = {
  unit: 'registries',
  whenZero: 'Neither Claude Code registry was consulted — check that HOME (or CLAUDE_CONFIG_DIR) names the Claude configuration to list.',
};

const PluginListDataSchema = z.object({
  target: z.literal('code'),
  /** Where each registry was read from: `installed_plugins.json`, and the legacy `skills/` directory. */
  sources: z.object({ pluginRegistry: z.string(), legacySkillsDir: z.string() }).strict(),
  plugins: z.array(z.object({
    name: z.string(),
    marketplace: z.string(),
    version: z.string(),
    installedAt: z.string(),
    source: z.string(),
  }).strict()),
  legacySkills: z.array(z.object({ name: z.string(), path: z.string(), type: z.string() }).strict()),
}).strict();

export type PluginListData = z.infer<typeof PluginListDataSchema>;

/** The document this command publishes. */
export const PLUGIN_LIST_REPORT_SCHEMA = reportSchema(PluginListDataSchema, FindingSchema);

export type PluginListReport = Report<PluginListData>;
