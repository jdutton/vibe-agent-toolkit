/**
 * The document `vat claude marketplace publish` publishes, apart from the command.
 *
 * A sibling module because the published-shape registry imports it and the
 * command imports the writer that imports the registry (the cycle
 * `report-schemas.ts` describes).
 *
 * `examined` counts the marketplaces with a `publish:` block the run reached.
 * A project where none declares one examines nothing, and the writer refuses
 * that run.
 */

import { FindingSchema, reportSchema, type Report } from '@vibe-agent-toolkit/schema';
import { z } from 'zod';

import type { ExaminedDeclaration } from '../../../utils/run-integrity.js';

/** What `examined` counts for `vat claude marketplace publish`, and the remedy when it is zero. */
export const MARKETPLACE_PUBLISH_EXAMINED: ExaminedDeclaration = {
  unit: 'marketplaces',
  whenZero: 'No marketplace declares a publish: block — add claude.marketplaces.<name>.publish to vibe-agent-toolkit.config.yaml.',
};

const MarketplacePublishDataSchema = z.object({
  published: z.array(z.object({
    marketplace: z.string(),
    /** The single plugin's version for a one-plugin marketplace; `null` when there is no aggregate version. */
    version: z.string().nullable(),
    branch: z.string(),
    /** The files composed into the published tree, relative to its root. */
    files: z.array(z.string()),
    dryRun: z.boolean(),
  }).strict()),
}).strict();

export type MarketplacePublishData = z.infer<typeof MarketplacePublishDataSchema>;

/** The document this command publishes. */
export const MARKETPLACE_PUBLISH_REPORT_SCHEMA = reportSchema(MarketplacePublishDataSchema, FindingSchema);

export type MarketplacePublishReport = Report<MarketplacePublishData>;
