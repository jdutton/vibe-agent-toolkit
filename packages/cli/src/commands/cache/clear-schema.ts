/**
 * The document `vat cache clear` publishes, apart from the command.
 *
 * A sibling module because the published-shape registry imports it and the
 * command imports the writer that imports the registry (the cycle
 * `report-schemas.ts` describes).
 *
 * `examined` counts the cache locations considered — always one, the shared
 * `<tmpdir>/.vat-cache` root. A root that does not exist is considered and
 * empty (`existed: false`, `ok`). The tree is moved off its path whole before it
 * is removed, so there is no partial clear: a refusal before that is the error
 * branch with `data: null`; a delete the OS stops after it is the error branch
 * (`RUN_INCOMPLETE`) with this `data` — the clear is done — and a
 * TREE_CLEANUP_INCOMPLETE warning naming where the moved-aside tree is.
 */

import { FindingSchema, reportSchema, type Report } from '@vibe-agent-toolkit/schema';
import { z } from 'zod';

import type { ExaminedDeclaration } from '../../utils/run-integrity.js';

/** What `examined` counts for `vat cache clear`, and the remedy when it is zero. */
export const CACHE_CLEAR_EXAMINED: ExaminedDeclaration = {
  unit: 'cache locations',
  whenZero: 'No cache location was considered, which is a defect in VAT — report it with the output of vat cache clear --debug.',
};

const CacheClearDataSchema = z.object({
  /** Absolute path of the tree targeted. */
  cacheDir: z.string(),
  /** Whether the directory was there at all. */
  existed: z.boolean(),
  /** Top-level entries that are gone, sorted. */
  removed: z.array(z.string()),
  /** Files (and other non-directory entries) actually removed. */
  entriesRemoved: z.number().int().nonnegative(),
  /** Bytes actually removed. */
  bytesRemoved: z.number().int().nonnegative(),
}).strict();

export type CacheClearData = z.infer<typeof CacheClearDataSchema>;

/** The document this command publishes. */
export const CACHE_CLEAR_REPORT_SCHEMA = reportSchema(CacheClearDataSchema, FindingSchema);

export type CacheClearReport = Report<CacheClearData>;
