import { chmodSync, lstatSync, readdirSync } from 'node:fs';

import { applyTreePlan, applyTreePlanOrLeftover, isParkedTreeEntry, mkdirSyncReal, planTreeChanges, safePath, toForwardSlash, VatError, withFsFaultSync } from '@vibe-agent-toolkit/utils';

/** A fetch-cache root or entry that another user owns: VAT will not read, replace or verify it. */
export const FETCH_CACHE_NOT_OWNED_CODE = 'FETCH_CACHE_NOT_OWNED';

export interface CachedFetchArgs {
  /** Per-user cache root (created 0700 if absent). */
  cacheDir: string;
  /** Integrity digest — PART of the cache key so a changed digest misses (spec §11a). */
  digest: string;
  /** Stable logical key (e.g. sanitized URL or package@version). */
  key: string;
  /** Force re-download/re-resolve (verify still runs). */
  refresh?: boolean;
  /** Populate the (empty) cache entry dir. Runs only on a miss or refresh. */
  fetchInto: (dir: string) => Promise<void>;
  /** Re-check integrity against `digest`. Runs on EVERY call (hit and miss). */
  verify: (dir: string) => Promise<void>;
}

/**
 * Content-addressed fetch cache with mandatory §11a hardening:
 *  - cache root + entries are 0700 and refused (`FETCH_CACHE_NOT_OWNED`) if not owned by the current uid;
 *  - the entry key INCLUDES the integrity digest, so changing a declared digest
 *    misses the old entry instead of reusing stale content;
 *  - verify() runs unconditionally before returning, even on a cache hit and even
 *    under refresh.
 *
 * A miss or a refresh is ONE tree-change plan: the entry is fetched into a staged
 * directory beside it and swapped in whole, so an entry only ever exists fully
 * populated, and a refresh whose fetch fails leaves the previous entry as it was.
 *
 * @returns Forward-slash absolute path to the cached entry directory.
 */
export async function withCachedFetch(args: CachedFetchArgs): Promise<string> {
  const currentUid = process.getuid?.() ?? -1;
  ensureOwned0700(args.cacheDir, currentUid);
  await sweepParkedEntries(args.cacheDir);

  const entry = safePath.join(args.cacheDir, `${args.key}-${args.digest}`);
  // The cache is VAT's own state: whatever is at the entry may be replaced — once it is shown to be ours.
  const plan = await planTreeChanges([{
    op: 'replace',
    dest: entry,
    ownership: { kind: 'vat-state' },
    fill: { from: 'write', write: args.fetchInto },
    label: `fetch-cache entry ${args.key}`,
  }]);
  const existing = plan.changes[0]?.existing ?? 'absent';
  if (existing !== 'absent') assertOwned(entry, currentUid);
  // Only a directory is a hit: anything else at the entry's name is not an entry, and is replaced.
  if (existing !== 'directory' || args.refresh === true) {
    // A previous entry the OS would not then delete has no report to be named in: it stays parked
    // beside the new one, and the next fetch's sweep (`sweepParkedEntries`) takes it.
    await applyTreePlan(plan);
  }

  // Verify on EVERY path (hit or miss) before handing the dir back.
  await args.verify(entry);
  return toForwardSlash(entry);
}

/**
 * Remove every previous entry a refresh moved aside and the OS would not then delete: the fetch
 * cache has no report to name one in, so without this they pile up. Only PARKED entries are taken —
 * never a staged one, which may be another process's fetch still in flight. One remove plan
 * (`vat-state`: VAT's own scratch); one that will not delete even now stays for the next fetch.
 *
 * @throws {FsFaultError} (side `environment` for the listing, `destination` for the plan) when the
 *   OS refuses to list the cache or to move an entry aside: a cache that cannot be written cannot fetch
 */
async function sweepParkedEntries(cacheDir: string): Promise<void> {
  const names = withFsFaultSync({ side: 'environment', action: 'list the fetch cache', path: cacheDir }, () => readdirSync(cacheDir));
  const parked = names.filter((name) => isParkedTreeEntry(name));
  if (parked.length === 0) return;
  const plan = await planTreeChanges(parked.map((name) => ({ op: 'remove' as const, dest: safePath.join(cacheDir, name), ownership: { kind: 'vat-state' as const }, label: 'leftover fetch-cache entry' })));
  // A leftover that will not go now is the same leftover the next fetch sweeps again.
  await applyTreePlanOrLeftover(plan);
}

function ensureOwned0700(dir: string, currentUid: number): void {
  mkdirSyncReal(dir, { recursive: true, mode: 0o700 });
  assertOwned(dir, currentUid);
  // Re-enforce 0700 in case the dir already existed with looser permissions.
  // assertOwned above confirms we own it, so chmod is safe.
  chmodSync(dir, 0o700);
}

/**
 * Refuse `path` — the cache root or an entry, as itself (`lstat`: a link is judged, never its
 * target) — unless the current user owns it. VAT's own scratch: a refused examination is an
 * `environment` fault.
 *
 * @throws VatError `FETCH_CACHE_NOT_OWNED` when another uid owns it
 */
function assertOwned(path: string, currentUid: number): void {
  const st = withFsFaultSync({ side: 'environment', action: 'examine the fetch cache', path }, () => lstatSync(path));
  if (currentUid >= 0 && st.uid !== currentUid) {
    throw new VatError(
      FETCH_CACHE_NOT_OWNED_CODE,
      `Refusing to use fetch-cache entry '${path}': ownership (uid ${st.uid}) ` +
        `does not match current user (uid ${currentUid}). Remove it, or point the fetch cache elsewhere.`,
    );
  }
}
