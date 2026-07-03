import { chmodSync, existsSync, mkdtempSync, renameSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';

import { mkdirSyncReal, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';

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
 *  - cache root + entries are 0700 and rejected if not owned by the current uid;
 *  - the entry key INCLUDES the integrity digest, so changing a declared digest
 *    misses the old entry instead of reusing stale content;
 *  - verify() runs unconditionally before returning, even on a cache hit and even
 *    under refresh.
 *
 * @returns Forward-slash absolute path to the cached entry directory.
 */
export async function withCachedFetch(args: CachedFetchArgs): Promise<string> {
  const currentUid = process.getuid?.() ?? -1;
  ensureOwned0700(args.cacheDir, currentUid);

  const entry = safePath.join(args.cacheDir, `${args.key}-${args.digest}`);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- entry under our 0700 cache root
  const hit = existsSync(entry);

  if (hit && args.refresh === true) {
    await rm(entry, { recursive: true, force: true });
  }

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- entry under our 0700 cache root
  const entryExists = existsSync(entry);
  if (entryExists) {
    assertOwned(entry, currentUid);
  } else {
    // Atomic write: fetch into a sibling temp dir, then rename into place so
    // `entry` only ever exists in a fully-populated state (no partial entries).
    const tmp = mkdtempSync(safePath.join(args.cacheDir, '.tmp-'));
    try {
      await args.fetchInto(tmp);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- entry and tmp under our 0700 cache root
      renameSync(tmp, entry);
    } catch (err) {
      await rm(tmp, { recursive: true, force: true });
      throw err;
    }
  }

  // Verify on EVERY path (hit or miss) before handing the dir back.
  await args.verify(entry);
  return toForwardSlash(entry);
}

function ensureOwned0700(dir: string, currentUid: number): void {
  mkdirSyncReal(dir, { recursive: true, mode: 0o700 });
  assertOwned(dir, currentUid);
  // Re-enforce 0700 in case the dir already existed with looser permissions.
  // assertOwned above confirms we own it, so chmod is safe.
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- our own cache root confirmed owned above
  chmodSync(dir, 0o700);
}

function assertOwned(dir: string, currentUid: number): void {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- ownership probe on our own cache path
  const st = statSync(dir);
  if (currentUid >= 0 && st.uid !== currentUid) {
    throw new Error(
      `Refusing to use fetch-cache entry '${dir}': ownership (uid ${st.uid}) ` +
        `does not match current user (uid ${currentUid}).`,
    );
  }
}
