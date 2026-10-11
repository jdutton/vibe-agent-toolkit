/**
 * The document `vat resources query` publishes, apart from the command.
 *
 * A sibling module because the published-shape registry imports it and the
 * command imports the writer that imports the registry: a schema declared in
 * the command module itself would be an import cycle, read before it is
 * initialised.
 *
 * 🔑 **`examined` is the population, not the rows.** A statement selecting
 * zero rows over a populated tree is a real answer (`ok`); a statement over a
 * population of zero resources is not one, and the writer refuses it.
 */

import { FindingSchema, reportSchema, type Report } from '@vibe-agent-toolkit/schema';
import { z } from 'zod';

import type { ExaminedDeclaration } from '../../utils/run-integrity.js';

import { StatedLimitSchema } from './check-schema.js';

/** What `examined` counts for `vat resources query`, and the remedy when it is zero. */
export const RESOURCES_QUERY_EXAMINED: ExaminedDeclaration = {
  unit: 'resources in the population',
  whenZero: 'The projection holds no tracked resource, so no statement over it answers anything: run from inside'
    + ' the project, and check that its files are tracked or not excluded.',
};

const ResourcesQueryDataSchema = z.object({
  /** The project the statement was asked about. */
  root: z.string(),
  /** The statement's result columns, in order — present even when it selected no row. */
  columns: z.array(z.string()),
  /** The selected rows, exactly as SQLite holds the values. */
  rows: z.array(z.record(z.string(), z.unknown())),
  /** Whether the projection was derived this run or read from the store — the cache tell. */
  population: z.enum(['derived', 'store']),
  /** What that population cost. */
  populationSecs: z.number().nonnegative(),
  /** What evaluating the lenses cost, paid before the statement ran. */
  lensSecs: z.number().nonnegative(),
  /** Which lenses that covers — the derived relations this statement named. */
  lensesEvaluated: z.array(z.string()),
  /** The prose frame `limits` is read under; present exactly when a bounded lens ran. */
  boundsStatement: z.string().optional(),
  /** What the derived rows do NOT settle; present exactly when a bounded lens ran. */
  limits: z.array(StatedLimitSchema).optional(),
}).strict();

export type ResourcesQueryData = z.infer<typeof ResourcesQueryDataSchema>;

/** The document this command publishes. */
export const RESOURCES_QUERY_REPORT_SCHEMA = reportSchema(ResourcesQueryDataSchema, FindingSchema);

export type ResourcesQueryReport = Report<ResourcesQueryData>;
