/**
 * `vat cache prune` — keep what this VAT reads, remove what no run of it ever will.
 *
 * A cache root that CI saves and restores (`VAT_CACHE_DIR`) only grows: every
 * VAT release writes a new namespace beside the old ones, and every change to
 * the projection's shape writes a new `projection-<digest>` store beside the
 * old one. Nothing reads them again. `clear` would reclaim them, but it also
 * throws away the warm cache the restore was for. Prune keeps exactly:
 *
 * - the root's `CACHEDIR.TAG` (the guard's marker — see {@link recognisedCacheRoot});
 * - the current namespace (`vatCacheNamespace()`), and inside it everything
 *   except `projection-*` directories other than the current shape's store.
 *
 * Everything else at the root goes — older namespaces, and the link-cache files
 * older releases kept there before they moved to `<tmpdir>/.vat-link-cache`.
 * The link cache itself is never touched: it is not under the root.
 */

import { projectionShapeDigest, VAT_CACHE_TAG_FILE, vatCacheNamespace } from '@vibe-agent-toolkit/resources';
import { buildReport, type Gate } from '@vibe-agent-toolkit/schema';
import { applyTreePlanOrLeftover, direntKind, planTreeChanges, safePath } from '@vibe-agent-toolkit/utils';

import { refusalCodeOf } from '../../utils/command-refusal.js';
import { endWithLeftoverRefusal, endWithRefusal, endWithReport, NOTHING_FINISHED } from '../../utils/document-writer.js';
import { createLogger } from '../../utils/logger.js';

import { addUsage, listedOrVanished, measureRoot, recognisedCacheRoot, sorted, type TreeUsage } from './cache-measure.js';
import type { CachePruneData } from './clear-schema.js';

const VERB = 'cache prune';
/** `vat cache prune` has no `--strict`, and its only finding is a leftover warning: the gate is fixed. */
const CACHE_PRUNE_GATE: Gate = { strict: false };
/** One location is considered on every run: the cache root. */
const CACHE_ROOTS_CONSIDERED = 1;
/** The prefix every projection store directory carries. */
const STORE_PREFIX = 'projection-';

export interface CachePruneOptions {
  debug?: boolean;
  dryRun?: boolean;
}

/** What one prune is told to keep, and where. Every field required: a default here would decide what is deleted. */
interface PruneTarget {
  /** The cache root, already proved VAT's. */
  readonly root: string;
  /** The release namespace to keep. */
  readonly namespace: string;
  /** The store directory name to keep inside the namespace (`projection-<digest>`). */
  readonly keptStore: string;
  /** Measure and report, delete nothing. */
  readonly dryRun: boolean;
}

/** What a prune finished, and — when the OS would not delete what it moved aside — that failure. */
interface CachePruneOutcome {
  readonly data: CachePruneData;
  readonly leftover?: unknown;
}

/**
 * The entries a prune of `target` removes, relative to the root: every
 * top-level entry but the tag and the namespace, and every other-shape store
 * inside the namespace.
 */
async function pruneCandidates(target: PruneTarget): Promise<string[]> {
  const top = await listedOrVanished(target.root);
  if (top === null) return [];
  const keptAtRoot = new Set([VAT_CACHE_TAG_FILE, target.namespace]);
  const candidates = top.filter((entry) => !keptAtRoot.has(entry.name)).map((entry) => entry.name);
  const namespaceEntry = top.find((entry) => entry.name === target.namespace);
  if (namespaceEntry === undefined || direntKind(namespaceEntry) !== 'directory') return candidates;
  const inside = (await listedOrVanished(safePath.join(target.root, target.namespace))) ?? [];
  const staleStores = inside.filter((entry) => entry.name.startsWith(STORE_PREFIX) && entry.name !== target.keptStore);
  return [...candidates, ...staleStores.map((entry) => `${target.namespace}/${entry.name}`)];
}

/**
 * Measure, then (unless `dryRun`) remove, every entry the prune does not keep,
 * as ONE tree-change plan of `vat-state` removes — so a delete the OS stops
 * after the entries are moved aside is a `leftover` naming them, never a
 * half-pruned root.
 *
 * Does not guard: the caller hands it a root it already proved is VAT's.
 *
 * @param target - The root and what to keep in it
 * @returns What was (or would be) removed, and the `leftover` the OS would not delete
 * @throws {FsFaultError} when the OS refuses to list, measure or move an entry — nothing is removed then
 */
export async function pruneCacheRoot(target: PruneTarget): Promise<CachePruneOutcome> {
  const candidates = await pruneCandidates(target);
  const plan = await planTreeChanges(
    candidates.map((relative) => ({ op: 'remove' as const, dest: safePath.join(target.root, relative), ownership: { kind: 'vat-state' as const }, label: `the stale cache entry ${relative}` }))
  );

  // An entry the plan found absent, or that vanished before it was measured, is not reported as removed.
  const measurements = await Promise.all(
    plan.changes.map(async (planned, index) => {
      const relative = candidates[index];
      if (relative === undefined || planned.existing === 'absent') return undefined;
      const measured = await measureRoot(safePath.join(target.root, relative), planned.existing);
      return measured === undefined ? undefined : { relative, usage: measured.usage };
    })
  );
  const present = measurements.filter((measured) => measured !== undefined);
  const removed = present.map((measured) => measured.relative);
  const usage: TreeUsage = present.map((measured) => measured.usage).reduce(addUsage, { entries: 0, bytes: 0 });

  const data: CachePruneData = {
    cacheDir: target.root,
    namespace: target.namespace,
    keptStore: `${target.namespace}/${target.keptStore}`,
    dryRun: target.dryRun,
    removed: sorted(removed),
    entriesRemoved: usage.entries,
    bytesRemoved: usage.bytes,
  };
  if (target.dryRun || removed.length === 0) return { data };
  const { leftover } = await applyTreePlanOrLeftover(plan);
  return leftover === undefined ? { data } : { data, leftover };
}

/**
 * Command entry point: prune the guarded cache root and publish the report.
 *
 * @param options - `--dry-run`, and `--debug` inherited from the root
 */
export async function cachePruneCommand(options: CachePruneOptions = {}): Promise<void> {
  const logger = createLogger(options.debug ? { debug: true } : {});

  let outcome: CachePruneOutcome;
  try {
    const root = recognisedCacheRoot();
    outcome = await pruneCacheRoot({ root, namespace: vatCacheNamespace(), keptStore: `${STORE_PREFIX}${projectionShapeDigest()}`, dryRun: options.dryRun === true });
  } catch (error) {
    return endWithRefusal(VERB, refusalCodeOf(error), error, 'yaml', CACHE_PRUNE_GATE, NOTHING_FINISHED);
  }
  const { data, leftover } = outcome;
  if (leftover !== undefined) return endWithLeftoverRefusal(VERB, leftover, 'yaml', CACHE_PRUNE_GATE, { examined: CACHE_ROOTS_CONSIDERED, findings: [], data });
  logger.debug(`${data.dryRun ? 'Would prune' : 'Pruned'} ${String(data.removed.length)} entries from ${data.cacheDir}`);
  endWithReport(VERB, buildReport({ examined: CACHE_ROOTS_CONSIDERED, findings: [], data, gate: CACHE_PRUNE_GATE }), 'yaml');
}
