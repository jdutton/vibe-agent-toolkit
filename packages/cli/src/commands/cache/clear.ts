/**
 * `vat cache clear` — delete every VAT cache on the machine this process can see.
 *
 * "Recovery is rescan" was true but had no user-invocable form: a corrupt or
 * merely stale cache could only be cleared by hand-deleting a path the docs
 * described in prose. This is that path, named once.
 *
 * Two locations, both removed whole:
 *
 * 1. **The cache root** (`vatCacheRoot()`: `VAT_CACHE_DIR`, else
 *    `<tmpdir>/.vat-cache`) — every release namespace under it, each holding the
 *    parse cache and the projection store
 *    (`<namespace>/projection-<shapeDigest>/projection.db`), which is by far the
 *    largest tenant (71 MB for one 12,602-file tree). It is the directory CI
 *    persists, so it is the one guarded: see {@link recognisedCacheRoot}.
 * 2. **The link cache** (`vatLinkCacheDirectory()`: `<tmpdir>/.vat-link-cache`) —
 *    the external-URL results and the per-OS-user authenticated-link content.
 *    They live outside the root because they are answers about the network and
 *    one user's credentials, never something to carry between machines.
 *
 * "Clear the cache" cannot honestly mean "clear one of them"; all of them are
 * disposable by construction.
 */

import { vatLinkCacheDirectory } from '@vibe-agent-toolkit/resources';
import { buildReport, type Gate } from '@vibe-agent-toolkit/schema';
import { applyTreePlanOrLeftover, isFsFaultError, planTreeChanges } from '@vibe-agent-toolkit/utils';

import { refusalCodeOf } from '../../utils/command-refusal.js';
import { endWithLeftoverRefusal, endWithRefusal, endWithReport, type FinishedWork, NOTHING_FINISHED } from '../../utils/document-writer.js';
import { createLogger } from '../../utils/logger.js';

import { goneNow, measureRoot, recognisedCacheRoot, sorted } from './cache-measure.js';
import type { CacheClearData, CacheLocationCleared } from './clear-schema.js';

/** `vat cache clear` has no `--strict`, and its only finding is a leftover warning: the gate is fixed. */
const VERB = 'cache clear';
const CACHE_CLEAR_GATE: Gate = { strict: false };

export interface CacheClearOptions {
  debug?: boolean;
}

/** What clearing one location finished: what it removed, and — when the OS would not then delete the tree it moved aside — that failure. */
interface CacheClearOutcome {
  readonly data: CacheLocationCleared;
  /** The moved-aside cache the OS would not delete: a `destination` fault naming where it is. */
  readonly leftover?: unknown;
}

/**
 * Measure, then delete, one cache location whole, as ONE tree-change plan: a
 * `remove` of state VAT owns outright (`vat-state`).
 *
 * Measured BEFORE the delete, because afterwards there is nothing left to count
 * and a report of "removed: unknown" would make the command unverifiable.
 *
 * The tree is moved off its path whole, then removed — so a delete the OS stops
 * (another VAT writing into the shared tree, a file it will not unlink) leaves no
 * part of a cache where the next run looks: the clear is done, and the failure is
 * returned as `leftover`, naming where the moved-aside tree is — never a "partial"
 * clear. A read-only directory the owner made is made writable on the way down,
 * so it does not stop the delete.
 *
 * Deliberately reads no environment: `vat cache clear` runs whether or not
 * caching is enabled for this process. A `VAT_CACHE=0` that also disarmed the
 * cleanup would leave an operator with a cache they can neither use nor remove.
 * Nor does it guard: the caller hands it a directory it already proved is VAT's.
 *
 * @param cacheDir - Directory to remove, in full
 * @returns What was removed, and the `leftover` of a moved-aside tree the OS would not delete
 * @throws {FsFaultError} an `environment` fault (`RUN_INCOMPLETE`) when the OS refuses to
 *   list or stat an entry during the measurement; a `destination` fault (`RUN_INCOMPLETE`)
 *   when it refuses to examine the cache path or to move the tree off it — nothing is
 *   removed then
 */
export async function clearCacheDirectory(cacheDir: string): Promise<CacheClearOutcome> {
  const absent = { data: { cacheDir, existed: false, removed: [], entriesRemoved: 0, bytesRemoved: 0 } };
  const plan = await planTreeChanges([{ op: 'remove', dest: cacheDir, ownership: { kind: 'vat-state' }, label: 'the VAT cache' }]);
  const existing = plan.changes[0]?.existing ?? 'absent';
  if (existing === 'absent') return absent;

  // Another clear (any VAT on the machine) may take the cache between the plan and the move: gone
  // is the goal state, so that is a clear of nothing — never a refusal.
  const measured = await measureRoot(cacheDir, existing);
  if (measured === undefined) return absent;
  let leftover: unknown;
  try {
    ({ leftover } = await applyTreePlanOrLeftover(plan));
  } catch (error: unknown) {
    if (isFsFaultError(error) && error.faultClass === 'absent' && goneNow(cacheDir)) return absent;
    throw error;
  }

  const { names, usage } = measured;
  const data = { cacheDir, existed: true, removed: sorted(names), entriesRemoved: usage.entries, bytesRemoved: usage.bytes };
  return leftover === undefined ? { data } : { data, leftover };
}

/** The document's data for the locations cleared so far. */
function clearData(locations: readonly CacheLocationCleared[]): CacheClearData {
  return {
    locations: [...locations],
    entriesRemoved: locations.reduce((total, location) => total + location.entriesRemoved, 0),
    bytesRemoved: locations.reduce((total, location) => total + location.bytesRemoved, 0),
  };
}

/**
 * Command entry point: clear the guarded cache root and the link cache, and publish the report.
 *
 * A complete clear is `ok` — nothing there to remove included. A cache root
 * that is not recognisably VAT's is refused before anything is touched
 * (`USAGE_INVALID`, `data: null`). A refusal part-way publishes the error
 * branch with the locations already cleared. A location that is off its path
 * is cleared: a delete the OS then stops is still `RUN_INCOMPLETE`, published
 * with the clear's `data` and a TREE_CLEANUP_INCOMPLETE warning naming where
 * the moved-aside tree is.
 *
 * @param options - Command options (only `--debug`, inherited from the root)
 */
export async function cacheClearCommand(options: CacheClearOptions = {}): Promise<void> {
  const logger = createLogger(options.debug ? { debug: true } : {});

  let targets: string[];
  try {
    targets = [recognisedCacheRoot(), vatLinkCacheDirectory()];
  } catch (error) {
    return refuse(error, NOTHING_FINISHED);
  }

  const { outcomes, refusal } = await clearInOrder(targets, []);
  const cleared = outcomes.map((outcome) => outcome.data);
  if (refusal !== undefined) {
    return refuse(refusal.error, cleared.length === 0 ? NOTHING_FINISHED : { examined: cleared.length, findings: [], data: clearData(cleared) });
  }

  const data = clearData(cleared);
  const firstLeftover = outcomes.find((outcome) => outcome.leftover !== undefined)?.leftover;
  if (firstLeftover !== undefined) return endWithLeftoverRefusal(VERB, firstLeftover, 'yaml', CACHE_CLEAR_GATE, { examined: targets.length, findings: [], data });
  logger.debug(`Cleared ${String(data.entriesRemoved)} cache entries from ${targets.join(' and ')}`);
  endWithReport(VERB, buildReport({ examined: targets.length, findings: [], data, gate: CACHE_CLEAR_GATE }), 'yaml');
}

/**
 * Clear `targets` one after another — never concurrently, so a refusal at the
 * cache root stops the run before the link cache is touched — and stop at the
 * first refusal, returning the outcomes finished before it.
 */
async function clearInOrder(
  targets: readonly string[],
  finished: readonly CacheClearOutcome[],
): Promise<{ outcomes: readonly CacheClearOutcome[]; refusal?: { error: unknown } }> {
  const [next, ...rest] = targets;
  if (next === undefined) return { outcomes: finished };
  let outcome: CacheClearOutcome;
  try {
    outcome = await clearCacheDirectory(next);
  } catch (error) {
    return { outcomes: finished, refusal: { error } };
  }
  return clearInOrder(rest, [...finished, outcome]);
}

/** End on the envelope's error branch: `error` refused, `finished` the work done before it. */
function refuse(error: unknown, finished: FinishedWork): never {
  return endWithRefusal(VERB, refusalCodeOf(error), error, 'yaml', CACHE_CLEAR_GATE, finished);
}
