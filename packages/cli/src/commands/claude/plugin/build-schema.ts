/**
 * The document `vat claude plugin build` publishes, apart from the command.
 *
 * A sibling module because the published-shape registry imports it and the
 * command imports the writer that imports the registry (the cycle
 * `report-schemas.ts` describes).
 *
 * `examined` counts the marketplaces the build reached. A project with no
 * `claude.marketplaces` examines none, and the writer refuses that run.
 *
 * Every path is relative to the directory holding
 * `vibe-agent-toolkit.config.yaml` — the root whose config the build read —
 * so the document never carries `$HOME`.
 */

import { ExternalPluginSourceSchema } from '@vibe-agent-toolkit/resources';
import { FindingSchema, reportSchema, type Report } from '@vibe-agent-toolkit/schema';
import { z } from 'zod';

import type { ExaminedDeclaration } from '../../../utils/run-integrity.js';

/** What `examined` counts for `vat claude plugin build`, and the remedy when it is zero. */
export const PLUGIN_BUILD_EXAMINED: ExaminedDeclaration = {
  unit: 'marketplaces',
  whenZero: 'No marketplace was built — declare one under claude.marketplaces in vibe-agent-toolkit.config.yaml.',
};

const PluginBuildDataSchema = z.object({
  /** Marketplaces whose every plugin was assembled and whose marketplace.json was written. */
  marketplacesBuilt: z.number().int().nonnegative(),
  pluginsBuilt: z.number().int().nonnegative(),
  /** Plugins entered by `externalSource`: listed in marketplace.json, never built. */
  pluginsReferenced: z.number().int().nonnegative(),
  /** Pool skills copied into the built plugins. */
  skillsPackaged: z.number().int().nonnegative(),
  marketplaces: z.array(z.object({
    name: z.string(),
    status: z.enum(['ok', 'findings']),
    /** Why the marketplace stopped short of its marketplace.json — a plugin failed the build gate. */
    reason: z.string().optional(),
    plugins: z.array(z.object({
      name: z.string(),
      outputPath: z.string(),
      skills: z.array(z.string()),
    }).strict()),
    externalPlugins: z.array(z.object({
      name: z.string(),
      version: z.string().optional(),
      /** The same object marketplace.json carries as this entry's `source`. */
      source: ExternalPluginSourceSchema,
    }).strict()),
  }).strict()),
}).strict();

export type PluginBuildData = z.infer<typeof PluginBuildDataSchema>;

/** The document this command publishes. */
export const PLUGIN_BUILD_REPORT_SCHEMA = reportSchema(PluginBuildDataSchema, FindingSchema);

export type PluginBuildReport = Report<PluginBuildData>;
