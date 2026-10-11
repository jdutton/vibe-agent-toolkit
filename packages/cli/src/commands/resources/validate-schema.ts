/**
 * The document `vat resources validate` publishes, apart from the command.
 *
 * A sibling module because the published-shape registry imports it and the
 * command imports the writer that imports the registry: a schema declared in
 * the command module itself would be an import cycle, read before it is
 * initialised.
 *
 * 🔑 **One base, one meaning of `summary`.** `data.root` is the project root,
 * stated once; every finding's `location` and every `data.files[].path` is
 * relative to it. `summary` — on the envelope, on a collection, on a file row —
 * always counts FINDINGS by severity; the number of resources validated is the
 * envelope's `examined`.
 */

import { FindingSchema, reportSchema, SeverityCountsSchema, type Report } from '@vibe-agent-toolkit/schema';
import { z } from 'zod';

import type { ExaminedDeclaration } from '../../utils/run-integrity.js';

/** What `examined` counts for `vat resources validate`, and the remedy when it is zero. */
export const RESOURCES_VALIDATE_EXAMINED: ExaminedDeclaration = {
  unit: 'resources',
  whenZero: 'The path names no markdown, resources.include/resources.exclude enumerate nothing (a broad exclude, a'
    + ' shallow or sparse checkout, a root that resolved somewhere else), or --collection names a collection'
    + ' no file matched. `vat resources scan` over the same path lists what an enumeration finds.',
};

/** One configured collection, as this run saw it. */
const CollectionSchema = z.object({
  /** Resources in the collection. */
  resourceCount: z.number().int().nonnegative(),
  /** Whether the collection declares a frontmatter schema. */
  hasSchema: z.boolean(),
  /** How that schema is applied, when it declares one. */
  validationMode: z.enum(['strict', 'permissive']).optional(),
  /** Files in the collection carrying at least one error-severity finding. */
  filesWithErrors: z.number().int().nonnegative(),
  /** The findings located in the collection's files, by severity. */
  summary: SeverityCountsSchema,
}).strict();

/** One validated resource — every one, clean or not — under `--verbose`. */
const FileRowSchema = z.object({
  /** Relative to `data.root`, forward slashes. */
  path: z.string(),
  status: z.enum(['ok', 'findings']),
  /** The findings located in this file, by severity. */
  summary: SeverityCountsSchema,
}).strict();

const ResourcesValidateDataSchema = z.object({
  /** The project root — the ONE base every finding `location` and file `path` is relative to. */
  root: z.string(),
  /** Every configured collection, keyed by id; `{}` when the project configures none. */
  collections: z.record(z.string(), CollectionSchema),
  /** Present only under `--verbose`: one row per resource validated. */
  files: z.array(FileRowSchema).optional(),
}).strict();

export type ResourcesValidateData = z.infer<typeof ResourcesValidateDataSchema>;

/** The document this command publishes. */
export const RESOURCES_VALIDATE_REPORT_SCHEMA = reportSchema(ResourcesValidateDataSchema, FindingSchema);

export type ResourcesValidateReport = Report<ResourcesValidateData>;
