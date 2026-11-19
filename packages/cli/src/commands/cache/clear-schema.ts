/**
 * The documents `vat cache clear` and `vat cache prune` publish, apart from the commands.
 *
 * A sibling module because the published-shape registry imports it and the
 * commands import the writer that imports the registry (the cycle
 * `report-schemas.ts` describes).
 *
 * **clear** — `examined` counts the cache locations considered: the cache root
 * (`VAT_CACHE_DIR`, else `<tmpdir>/.vat-cache`) and the link cache
 * (`<tmpdir>/.vat-link-cache`). A location that does not exist is considered
 * and empty (`existed: false`, `ok`). Each is moved off its path whole before
 * it is removed, so there is no partial clear of a location: a refusal before
 * any is moved is the error branch with `data: null`; one after the first is
 * the error branch carrying the locations already cleared; a delete the OS
 * stops after the move is the error branch (`RUN_INCOMPLETE`) with this `data`
 * and a TREE_CLEANUP_INCOMPLETE warning naming where the moved-aside tree is.
 *
 * **prune** — `examined` counts the cache roots considered: always one. A root
 * that does not exist is considered and holds nothing to prune (`ok`).
 */

import { FindingSchema, reportSchema, type Report } from '@vibe-agent-toolkit/schema';
import { z } from 'zod';

import type { ExaminedDeclaration } from '../../utils/run-integrity.js';

/** What `examined` counts for `vat cache clear`, and the remedy when it is zero. */
export const CACHE_CLEAR_EXAMINED: ExaminedDeclaration = {
  unit: 'cache locations',
  whenZero: 'No cache location was considered, which is a defect in VAT — report it with the output of vat cache clear --debug.',
};

/** What `examined` counts for `vat cache prune`, and the remedy when it is zero. */
export const CACHE_PRUNE_EXAMINED: ExaminedDeclaration = {
  unit: 'cache roots',
  whenZero: 'No cache root was considered, which is a defect in VAT — report it with the output of vat cache prune --debug.',
};

const byteCount = z.number().int().nonnegative();

const CacheLocationClearedSchema = z.object({
  /** Absolute path of the tree targeted. */
  cacheDir: z.string(),
  /** Whether the directory was there at all. */
  existed: z.boolean(),
  /** Top-level entries that are gone, sorted. */
  removed: z.array(z.string()),
  /** Files (and other non-directory entries) actually removed. */
  entriesRemoved: byteCount,
  /** Bytes actually removed. */
  bytesRemoved: byteCount,
}).strict();

export type CacheLocationCleared = z.infer<typeof CacheLocationClearedSchema>;

const CacheClearDataSchema = z.object({
  /** Each location cleared, cache root first. */
  locations: z.array(CacheLocationClearedSchema),
  /** Files removed across every location. */
  entriesRemoved: byteCount,
  /** Bytes removed across every location. */
  bytesRemoved: byteCount,
}).strict();

export type CacheClearData = z.infer<typeof CacheClearDataSchema>;

/** The document `vat cache clear` publishes. */
export const CACHE_CLEAR_REPORT_SCHEMA = reportSchema(CacheClearDataSchema, FindingSchema);

export type CacheClearReport = Report<CacheClearData>;

const CachePruneDataSchema = z.object({
  /** Absolute path of the cache root pruned. */
  cacheDir: z.string(),
  /** The release namespace kept. */
  namespace: z.string(),
  /** The projection store directory kept, relative to the root. */
  keptStore: z.string(),
  /** True when nothing was deleted: `removed` and the totals say what WOULD go. */
  dryRun: z.boolean(),
  /** Entries removed (or that would be), relative to the root with forward slashes, sorted. */
  removed: z.array(z.string()),
  /**
   * Entries prune would have removed but left, because a running VAT has a
   * projection store in them open (another worktree's or release's, under a
   * shared root). Relative to the root, sorted. A later prune removes them.
   */
  inUse: z.array(z.string()),
  /** Files (and other non-directory entries) removed. */
  entriesRemoved: byteCount,
  /** Bytes removed. */
  bytesRemoved: byteCount,
}).strict();

export type CachePruneData = z.infer<typeof CachePruneDataSchema>;

/** The document `vat cache prune` publishes. */
export const CACHE_PRUNE_REPORT_SCHEMA = reportSchema(CachePruneDataSchema, FindingSchema);
