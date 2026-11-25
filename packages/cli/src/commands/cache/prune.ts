/**
 * `vat cache prune` — keep what this VAT reads, remove what no run of it ever will.
 *
 * A cache root that CI saves and restores (`VAT_CACHE_DIR`) only grows: every
 * VAT release writes a new namespace beside the old ones, and every change to
 * the projection's shape writes a new `projection-<digest>` store beside the
 * old one. `clear` would reclaim them, but it also throws away the warm cache
 * the restore was for. Prune removes only entries VAT recognises as its own
 * (`isVatCacheRootEntryName`, `isProjectionStoreDirectoryName`):
 *
 * - at the root, every namespace but this version's (older AND newer releases,
 *   prereleases included; a namespace is the VAT version alone, so every
 *   checkout and install of this version shares the kept one), and what older
 *   releases kept there: the link-cache files
 *   (before they moved to `<tmpdir>/.vat-link-cache`) and the root-level
 *   `parse/` directory (before the parse cache moved under the namespace);
 * - inside this build's namespace, every projection store but this shape's.
 *
 * An entry it does not recognise is never touched, wherever it is: a
 * `VAT_CACHE_DIR` someone else also writes into keeps their files. The link
 * cache itself is never touched either: it is not under the root.
 */

import { isProjectionStoreDirectoryName, isVatCacheRootEntryName, projectionStoreDirectoryName, vatCacheNamespace } from '@vibe-agent-toolkit/resources';
import { buildReport, type Gate } from '@vibe-agent-toolkit/schema';
import { applyTreePlanOrLeftover, direntKind, planTreeChanges, safePath } from '@vibe-agent-toolkit/utils';

import { refusalCodeOf } from '../../utils/command-refusal.js';
import { endWithLeftoverRefusal, endWithRefusal, endWithReport, NOTHING_FINISHED } from '../../utils/document-writer.js';
import { createLogger } from '../../utils/logger.js';
import { storeInUse } from '../../utils/projection-store.js';

import { addUsage, listedOrVanished, measureRoot, recognisedCacheRoot, sorted, type TreeUsage } from './cache-measure.js';
import type { CachePruneData } from './clear-schema.js';

const VERB = 'cache prune';
/** `vat cache prune` has no `--strict`, and its only finding is a leftover warning: the gate is fixed. */
const CACHE_PRUNE_GATE: Gate = { strict: false };
/** One location is considered on every run: the cache root. */
const CACHE_ROOTS_CONSIDERED = 1;

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
  /** Whether a running VAT has the projection store in this directory open; an entry holding one is left. */
  readonly storeInUse: (storeDirectory: string) => Promise<boolean>;
}

/** What a prune finished, and — when the OS would not delete what it moved aside — that failure. */
interface CachePruneOutcome {
  readonly data: CachePruneData;
  readonly leftover?: unknown;
}

/** One entry a prune would remove, and the projection stores removing it would take with it. */
interface PruneCandidate {
  /** Relative to the root, forward-slashed. */
  readonly relative: string;
  /** Absolute store directories inside (or at) the entry. */
  readonly stores: readonly string[];
}

/**
 * The entries a prune of `target` removes, relative to the root: every VAT
 * root entry but the kept namespace, and every other-shape store inside it.
 * Only names VAT recognises as its own are ever candidates.
 */
async function pruneCandidates(target: PruneTarget): Promise<PruneCandidate[]> {
  const top = await listedOrVanished(target.root);
  if (top === null) return [];
  const atRoot = await Promise.all(
    top
      .filter((entry) => entry.name !== target.namespace && isVatCacheRootEntryName(entry.name))
      .map(async (entry) => ({
        relative: entry.name,
        stores: direntKind(entry) === 'directory' ? await storesInside(safePath.join(target.root, entry.name)) : [],
      })),
  );
  const namespaceEntry = top.find((entry) => entry.name === target.namespace);
  if (namespaceEntry === undefined || direntKind(namespaceEntry) !== 'directory') return atRoot;
  const inside = (await listedOrVanished(safePath.join(target.root, target.namespace))) ?? [];
  const staleStores = inside.filter((entry) => isProjectionStoreDirectoryName(entry.name) && entry.name !== target.keptStore);
  return [
    ...atRoot,
    ...staleStores.map((entry) => ({ relative: `${target.namespace}/${entry.name}`, stores: [safePath.join(target.root, target.namespace, entry.name)] })),
  ];
}

/**
 * @param namespace - A namespace directory under the root
 * @returns The projection store directories directly inside it
 */
async function storesInside(namespace: string): Promise<string[]> {
  const entries = (await listedOrVanished(namespace)) ?? [];
  return entries.filter((entry) => direntKind(entry) === 'directory' && isProjectionStoreDirectoryName(entry.name)).map((entry) => safePath.join(namespace, entry.name));
}

/**
 * Split candidates into those prune may remove and those holding a store a
 * running VAT has open. Asked just before the plan, so the window in which a
 * process can open a store after the answer is the delete itself.
 */
async function withoutStoresInUse(target: PruneTarget, candidates: readonly PruneCandidate[]): Promise<{ removable: string[]; inUse: string[] }> {
  const verdicts = await Promise.all(
    candidates.map(async (candidate) => ({
      relative: candidate.relative,
      held: (await Promise.all(candidate.stores.map((store) => target.storeInUse(store)))).includes(true),
    })),
  );
  return {
    removable: verdicts.filter((verdict) => !verdict.held).map((verdict) => verdict.relative),
    inUse: verdicts.filter((verdict) => verdict.held).map((verdict) => verdict.relative),
  };
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
  const { removable: candidates, inUse } = await withoutStoresInUse(target, await pruneCandidates(target));
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
  const usage: TreeUsage = present.map((measured) => measured.usage).reduce((total, next) => addUsage(total, next), { entries: 0, bytes: 0 });

  const data: CachePruneData = {
    cacheDir: target.root,
    namespace: target.namespace,
    keptStore: `${target.namespace}/${target.keptStore}`,
    dryRun: target.dryRun,
    removed: sorted(removed),
    inUse: sorted(inUse),
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
    outcome = await pruneCacheRoot({ root, namespace: vatCacheNamespace(), keptStore: projectionStoreDirectoryName(), dryRun: options.dryRun === true, storeInUse });
  } catch (error) {
    return endWithRefusal(VERB, refusalCodeOf(error), error, 'yaml', CACHE_PRUNE_GATE, NOTHING_FINISHED);
  }
  const { data, leftover } = outcome;
  if (leftover !== undefined) return endWithLeftoverRefusal(VERB, leftover, 'yaml', CACHE_PRUNE_GATE, { examined: CACHE_ROOTS_CONSIDERED, findings: [], data });
  logger.debug(`${data.dryRun ? 'Would prune' : 'Pruned'} ${String(data.removed.length)} entries from ${data.cacheDir}`);
  endWithReport(VERB, buildReport({ examined: CACHE_ROOTS_CONSIDERED, findings: [], data, gate: CACHE_PRUNE_GATE }), 'yaml');
}
