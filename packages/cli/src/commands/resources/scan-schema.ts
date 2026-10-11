/**
 * The document `vat resources scan` publishes, apart from the command.
 *
 * A sibling module because the published-shape registry imports it and the
 * command imports the writer that imports the registry: a schema declared in
 * the command module itself would be an import cycle, read before it is
 * initialised.
 *
 * 🔑 **The lab reads this document.** `packages/lab`'s population facet takes
 * the file count from the envelope's `examined` and the population from
 * `data.files` (with `--verbose`), qualified by `data.lane` and
 * `data.extentSource`. A rename here is a rename there.
 */

import { FindingSchema, reportSchema, type Report } from '@vibe-agent-toolkit/schema';
import { z } from 'zod';

import type { ExaminedDeclaration } from '../../utils/run-integrity.js';

/** What `examined` counts for `vat resources scan`, and the remedy when it is zero. */
export const RESOURCES_SCAN_EXAMINED: ExaminedDeclaration = {
  unit: 'files',
  whenZero: 'The path names no markdown, resources.include/resources.exclude enumerate nothing (a broad exclude, a'
    + ' shallow or sparse checkout, a root that resolved somewhere else), or --collection names a collection'
    + ' no file matched.',
};

/** One scanned file, under `--verbose`. */
const ScannedFileSchema = z.object({
  /** Relative to `data.root`, forward slashes. */
  path: z.string(),
  /** Links the file carries. */
  links: z.number().int().nonnegative(),
  /** Headings the file carries, every nested level counted. */
  anchors: z.number().int().nonnegative(),
  /** The content checksum the registry keyed the file on. */
  checksum: z.string(),
}).strict();

const ResourcesScanDataSchema = z.object({
  /** The project root — the ONE base every `files[].path` is relative to. */
  root: z.string(),
  /** Which enumerator produced the population: the walk, or the projection lane. */
  lane: z.enum(['walk', 'projection']),
  /**
   * Which enumerator the projection lane used, or `null` for the walk. Always
   * present: a key that vanished for the walk would read as a build too old to
   * report one.
   */
  extentSource: z.enum(['git', 'filesystem']).nullable(),
  /** Resources per collection that has any (only the `--collection` one when filtered); `{}` when none. */
  collections: z.record(z.string(), z.object({ resourceCount: z.number().int().nonnegative() }).strict()),
  /** Present only under `--verbose`: every scanned file. */
  files: z.array(ScannedFileSchema).optional(),
}).strict();

export type ResourcesScanData = z.infer<typeof ResourcesScanDataSchema>;

/** The document this command publishes. */
export const RESOURCES_SCAN_REPORT_SCHEMA = reportSchema(ResourcesScanDataSchema, FindingSchema);

export type ResourcesScanReport = Report<ResourcesScanData>;
