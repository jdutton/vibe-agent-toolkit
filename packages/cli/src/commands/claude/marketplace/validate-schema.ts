/**
 * The document `vat claude marketplace validate` publishes, apart from the
 * command.
 *
 * A sibling module because the published-shape registry imports it and the
 * command imports the writer that imports the registry: a schema declared in
 * the command module itself would be an import cycle, read before it is
 * initialised.
 *
 * 🔑 **One base, one meaning of `summary`.** `data.root` is the marketplace
 * directory, stated once; every finding's `location`, every plugin `path`, and
 * every `undeclared` / `refused` entry is relative to it. `summary` — on the
 * envelope and on a plugin row — always counts FINDINGS by severity. Every
 * finding is on the envelope, flat; a plugin row is a tally of the findings
 * its own validator published, never a second list.
 */

import { FindingSchema, reportSchema, SeverityCountsSchema, type Report } from '@vibe-agent-toolkit/schema';
import { z } from 'zod';

import type { ExaminedDeclaration } from '../../../utils/run-integrity.js';

/** What `examined` counts for `vat claude marketplace validate`, and the remedy when it is zero. */
export const MARKETPLACE_VALIDATE_EXAMINED: ExaminedDeclaration = {
  unit: 'plugin entries',
  whenZero: 'The marketplace manifest declares no plugin, or it could not be validated — point the command at'
    + ' a marketplace directory holding a valid .claude-plugin/marketplace.json with at least one entry in plugins[].',
};

/** The manifest's own facts, once it validated against the marketplace schema. */
const MarketplaceSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  version: z.string().optional(),
  /** Every entry the manifest's `plugins` list declares, remote and local. */
  pluginEntries: z.number().int().nonnegative().optional(),
  /** The entries whose `source` is a relative path — plugins this marketplace ships itself. */
  localPluginSources: z.array(z.object({ name: z.string(), source: z.string() }).strict()).optional(),
}).strict();

/** One declared local plugin the run walked, keyed by the manifest entry it satisfies. */
const PluginRowSchema = z.object({
  /** The manifest entry's `name`. */
  name: z.string(),
  /** The manifest entry's `source`, as the manifest wrote it. */
  source: z.string(),
  /** The directory the source resolved to, relative to `data.root`. */
  path: z.string(),
  /**
   * `false` when the plugin's `plugin.json` resolves outside the root and was
   * never opened — its row then counts nothing, and the run carries the
   * `RESOURCE_CHECK_BROKEN` finding naming it.
   */
  manifestRead: z.boolean(),
  status: z.enum(['ok', 'findings']),
  /** The findings the plugin's own validator published, by severity. */
  summary: SeverityCountsSchema,
}).strict();

const MarketplaceValidateDataSchema = z.object({
  /** The marketplace directory — the ONE base every `location` and path below is relative to. */
  root: z.string(),
  /** The manifest's facts; `null` when it is missing or does not validate. */
  marketplace: MarketplaceSchema.nullable(),
  /** One row per declared local plugin the run walked. */
  plugins: z.array(PluginRowSchema),
  /** Directories under `plugins/` no manifest entry names — listed, never graded. */
  undeclared: z.array(z.string()),
  /** Paths inside a walked plugin the run would not open: each resolves outside the root. */
  refused: z.array(z.string()),
}).strict();

export type MarketplaceValidateData = z.infer<typeof MarketplaceValidateDataSchema>;

/** The document this command publishes. */
export const MARKETPLACE_VALIDATE_REPORT_SCHEMA = reportSchema(MarketplaceValidateDataSchema, FindingSchema);

export type MarketplaceValidateReport = Report<MarketplaceValidateData>;
