/**
 * `vat cache clear` — delete VAT's shared temp-directory cache tree.
 *
 * "Recovery is rescan" was true but had no user-invocable form: a corrupt or
 * merely stale cache could only be cleared by hand-deleting a path the docs
 * described in prose. This is that path, named once.
 *
 * Scope is the WHOLE `<tmpdir>/.vat-cache/` tree, not just the parse tenant.
 * That directory is shared — `external-links.json`, `auth-<user>/`, `parse/` and
 * `<namespace>/projection-<shapeDigest>/projection.db` all live under it — and
 * "clear the cache" cannot honestly mean "clear one of the four". All of them
 * are disposable by construction.
 *
 * 🔑 **The projection store is the one that makes this command matter, and it is
 * covered by SCOPE rather than by a clause about it.** `defaultStoreDirectory()`
 * resolves through `vatCacheNamespaceRoot()`, so it is already inside the tree
 * this removes; the tenant list above is the only thing that has to keep up. It
 * is also by far the largest tenant (71 MB for one 12,602-file tree) and is on
 * by DEFAULT, which is why reclaiming it had to be invocable before the flip.
 *
 * ⚠️ A store relocated with `VAT_PROJECTION_STORE_DIR` is outside this tree and
 * is NOT removed — the variable names a directory this command was never told
 * about, and a clear that hunted for stores by shape would delete directories
 * the operator chose. Stated so nobody reads a clean `bytesRemoved` as "every
 * store is gone".
 */

import { type Dirent, promises as fs } from 'node:fs';
import { basename, dirname } from 'node:path';

import { parseCacheDirectory } from '@vibe-agent-toolkit/resources';
import { buildReport, type Gate, type RefusalCode } from '@vibe-agent-toolkit/schema';
import { direntKind, isPathAbsentError, safePath } from '@vibe-agent-toolkit/utils';

import { errorMessageOf, refusalCodeOf } from '../../utils/command-refusal.js';
import { endWithRefusal, endWithReport, NOTHING_FINISHED, type FinishedWork } from '../../utils/document-writer.js';
import { createLogger } from '../../utils/logger.js';
import { unstatablePathRefusal } from '../../utils/project-root-policy.js';

import type { CacheClearData } from './clear-schema.js';

/** The one name the shared cache root is allowed to have. See {@link vatCacheRoot}. */
const VAT_CACHE_DIR_NAME = '.vat-cache';

/** `vat cache clear` has no `--strict` and publishes no finding: the gate is fixed. */
const CACHE_CLEAR_GATE: Gate = { strict: false };

/** One location is considered on every run: the shared cache root. */
const CACHE_LOCATIONS_CONSIDERED = 1;

export interface CacheClearOptions {
  debug?: boolean;
}

/**
 * What a clear did.
 *
 * A delete that stops short is not a failure mode bolted on — it is the
 * *common* outcome when something else on the machine is writing to the shared
 * tree, and it has to be reportable. A recursive delete that gives up part-way
 * has already removed most of the cache; surfacing that as a bare thrown error
 * told the operator only that the command failed, while leaving them to guess
 * how much of their cache still existed. So an incomplete clear carries the
 * same `data` as a complete one — what went, what stayed, the counts actually
 * removed — plus why it stopped.
 */
type CacheClearOutcome =
  | { readonly complete: true; readonly data: CacheClearData }
  | { readonly complete: false; readonly data: CacheClearData | null; readonly reason: string };

interface TreeUsage {
  entries: number;
  bytes: number;
}

const EMPTY_USAGE: TreeUsage = { entries: 0, bytes: 0 };

/**
 * Retry budget for the recursive delete.
 *
 * Not defensive padding — observed. `<tmpdir>/.vat-cache` is shared by every VAT
 * on the machine: other worktrees, other sessions, and any adopter running an
 * *installed* vat all write into it under their own namespace. A `vat cache
 * clear` issued while one of them is mid-run walks a tree that is growing
 * underneath it and `rmdir` fails `ENOTEMPTY` on a shard that gained a file
 * between the listing and the removal. Reproduced twice against a concurrent
 * `vat verify`; the same command succeeded immediately once that run finished.
 *
 * Node retries exactly this error class (`EBUSY`, `EMFILE`, `ENFILE`,
 * `ENOTEMPTY`, `EPERM`) with a linear backoff, which clears a short overlap.
 * It cannot win against a writer that keeps going for the whole window — that
 * case still surfaces as an error, which is correct: "some of your cache is
 * gone and something is still writing" must not be reported as success.
 */
const RM_RETRY: { maxRetries: number; retryDelay: number } = { maxRetries: 5, retryDelay: 100 };

/**
 * The shared cache root, `<tmpdir>/.vat-cache`.
 *
 * Derived from `parseCacheDirectory()` rather than re-joining `normalizedTmpdir()`
 * with a third copy of the `.vat-cache` literal — one authority for where the
 * tree lives, and the CLI stays out of the path-resolution business.
 *
 * The name check is not decoration: this function's return value is handed
 * straight to a recursive delete, so if `parseCacheDirectory()` ever stopped
 * carrying a `parse/` leaf, the naive parent would be the system temp directory
 * itself. Refusing an unexpected shape turns that into an error instead of an
 * `rm -rf /tmp`.
 *
 * ⚠ `@vibe-agent-toolkit/resources` now also exports a `vatCacheRoot()`, and
 * `parseCacheDirectory()` is built from it — so on paper this derivation is a
 * round trip. It is kept deliberately: the guard's job is to notice if that
 * relationship ever changes, and importing the root directly would retire the
 * only check standing between a shape change and a recursive delete of
 * `<tmpdir>` itself. Deriving-then-verifying is the point.
 *
 * ✅ **It has now earned that keep.** When the cache gained a per-build
 * namespace, the layout went from `.vat-cache/parse` to
 * `.vat-cache/<namespace>/parse` and the old single-`dirname` derivation
 * started returning `.vat-cache/<namespace>`. The name check turned a silent
 * change of delete target into a loud refusal. Anyone tempted to simplify this
 * into an import should read that sentence twice.
 *
 * @returns Absolute path to the cache root
 * @throws {Error} If the derived ancestor is not named `.vat-cache`
 */
export function vatCacheRoot(): string {
  const parseDir = parseCacheDirectory();
  // Up two: `<root>/<namespace>/parse` → `<root>`. The namespace level is what
  // makes this two rather than one; see the note above about why it is still
  // derived and verified rather than imported.
  const root = dirname(dirname(parseDir));

  if (basename(root) !== VAT_CACHE_DIR_NAME) {
    throw new Error(
      `Refusing to clear ${root}: expected a directory named ${VAT_CACHE_DIR_NAME} (derived from ${parseDir}).`
    );
  }

  return root;
}

/**
 * Measure, then delete, an entire cache tree.
 *
 * Measured BEFORE the delete, because afterwards there is nothing left to count
 * and a report of "removed: unknown" would make the command unverifiable.
 *
 * Deliberately reads no environment: `vat cache clear` runs whether or not
 * caching is enabled for this process. A `VAT_CACHE=0` that also disarmed the
 * cleanup would leave an operator with a cache they can neither use nor remove.
 *
 * @param cacheDir - Directory to remove, in full
 * @returns What was removed, and whether the delete finished
 * @throws {CommandRefusalError} `INPUT_UNREADABLE` when the OS refuses to list or
 *   stat an entry during the measurement — before anything is deleted
 */
export async function clearCacheDirectory(cacheDir: string): Promise<CacheClearOutcome> {
  const entries = await readdirOrNull(cacheDir);

  if (entries === null) {
    return { complete: true, data: { cacheDir, existed: false, removed: [], remaining: [], entriesRemoved: 0, bytesRemoved: 0 } };
  }

  const usage = await measureEntries(cacheDir, entries);
  const names = entries.map((entry) => entry.name);

  try {
    await fs.rm(cacheDir, { recursive: true, force: true, ...RM_RETRY });
  } catch (error) {
    return partialOutcome(cacheDir, names, usage, error);
  }

  return {
    complete: true,
    data: {
      cacheDir,
      existed: true,
      removed: sorted(names),
      remaining: [],
      entriesRemoved: usage.entries,
      bytesRemoved: usage.bytes,
    },
  };
}

/**
 * Describe a delete that stopped part-way, by re-reading the tree.
 *
 * The survivors are read back off disk rather than inferred from the error,
 * because the error names one path and says nothing about the other ninety-nine
 * percent. Re-measuring what remains and subtracting is the only way the counts
 * describe what actually happened rather than what was attempted.
 *
 * A concurrent writer can make the remainder *larger* than the original
 * measurement, so the subtraction is floored at zero: reporting a negative
 * number of removed bytes would be worse than reporting none.
 *
 * @param cacheDir - The tree that was being removed
 * @param names - Top-level entry names as they were before the delete
 * @param before - Usage measured before the delete
 * When the OS refuses that re-read too, what went is unknowable: the outcome
 * is still incomplete — the delete stopped part-way, and its own error is the
 * cause — with no `data` and a reason naming both errors. Letting the re-read's
 * refusal escape would publish "could not read the cache" for a clear that ran.
 *
 * @param error - Whatever `fs.rm` threw
 * @returns An incomplete outcome naming what went, what stayed, and why
 */
async function partialOutcome(
  cacheDir: string,
  names: string[],
  before: TreeUsage,
  error: unknown,
): Promise<CacheClearOutcome> {
  const reason = `Cleared only part of ${cacheDir}: ${errorMessageOf(error)}`;
  let survivors: Dirent[];
  let after: TreeUsage;
  try {
    survivors = (await readdirOrNull(cacheDir)) ?? [];
    after = await measureEntries(cacheDir, survivors);
  } catch (rereadError) {
    return { complete: false, data: null, reason: `${reason}; what survived cannot be read back: ${errorMessageOf(rereadError)}` };
  }
  const remaining = new Set(survivors.map((entry) => entry.name));

  return {
    complete: false,
    reason,
    data: {
      cacheDir,
      existed: true,
      removed: sorted(names.filter((name) => !remaining.has(name))),
      remaining: sorted([...remaining]),
      entriesRemoved: Math.max(0, before.entries - after.entries),
      bytesRemoved: Math.max(0, before.bytes - after.bytes),
    },
  };
}

/** Stable ordering for the reported entry lists. */
function sorted(names: readonly string[]): string[] {
  return [...names].sort((left, right) => left.localeCompare(right));
}

/**
 * Command entry point: clear the real cache root and publish the report.
 *
 * A complete clear is `ok` — nothing there to remove included. A clear that
 * stopped part-way is the envelope's error branch, `RUN_INCOMPLETE`, carrying
 * what it removed and what survived: the operator most needs that account
 * precisely when the command did not finish.
 *
 * @param options - Command options (only `--debug`, inherited from the root)
 */
export async function cacheClearCommand(options: CacheClearOptions = {}): Promise<void> {
  const logger = createLogger(options.debug ? { debug: true } : {});

  let outcome: CacheClearOutcome;
  try {
    outcome = await clearCacheDirectory(vatCacheRoot());
  } catch (error) {
    refuse(refusalCodeOf(error), error, NOTHING_FINISHED);
  }

  if (!outcome.complete) {
    // No `data` means what went is unknowable — nothing can be claimed as finished.
    const finished = outcome.data === null ? NOTHING_FINISHED : { examined: CACHE_LOCATIONS_CONSIDERED, findings: [], data: outcome.data };
    refuse('RUN_INCOMPLETE', outcome.reason, finished);
  }
  logger.debug(`Cleared ${String(outcome.data.entriesRemoved)} cache entries from ${outcome.data.cacheDir}`);
  endWithReport('cache clear', buildReport({ examined: CACHE_LOCATIONS_CONSIDERED, findings: [], data: outcome.data, gate: CACHE_CLEAR_GATE }), 'yaml');
}

/** End on the envelope's error branch, carrying whatever finished. */
function refuse(code: RefusalCode, error: unknown, finished: FinishedWork): never {
  endWithRefusal('cache clear', code, error, 'yaml', CACHE_CLEAR_GATE, finished);
}

/**
 * `readdir` that reports a missing directory as `null` rather than throwing.
 *
 * Only an absence is absorbed. EACCES on a directory that exists is a genuine
 * failure — reporting it as "nothing to clear" would tell the operator their
 * cache is gone when it is still on disk — so it is the input's refusal,
 * classified by the shared absent-vs-unreadable predicate.
 */
async function readdirOrNull(dir: string): Promise<Dirent[] | null> {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isPathAbsentError(error)) return null;
    throw unstatablePathRefusal(dir, error);
  }
}

/** Sum file count and bytes over already-listed directory entries. */
async function measureEntries(
  dir: string,
  entries: Dirent[]
): Promise<TreeUsage> {
  const usages = await Promise.all(
    entries.map(async (entry) => {
      const child = safePath.join(dir, entry.name);
      // Not `isFile()`, and NOT followed: a symlink or socket is still an entry
      // that is about to be removed, and counting only regular files would
      // under-report it — while walking INTO a linked directory would count a
      // tree `rm -rf` leaves untouched.
      return direntKind(entry) === 'directory' ? measureTree(child) : { entries: 1, bytes: await sizeOf(child) };
    })
  );

  return usages.reduce(
    (total, usage) => ({ entries: total.entries + usage.entries, bytes: total.bytes + usage.bytes }),
    EMPTY_USAGE
  );
}

/** Recursive measure. A directory that vanished mid-walk contributes nothing. */
async function measureTree(dir: string): Promise<TreeUsage> {
  const entries = await readdirOrNull(dir);
  return entries === null ? EMPTY_USAGE : measureEntries(dir, entries);
}

/**
 * Size of one entry, without following symlinks.
 *
 * A file that disappears between the listing and the stat contributes 0 rather
 * than failing the clear — the whole tree is about to be deleted anyway, and a
 * concurrent vat run pruning its own temp file must not turn cleanup into an
 * error. Only a DISAPPEARANCE is 0: an entry the OS refuses to stat is still
 * there, still about to be counted as reclaimed, and the `rm` that follows is
 * about to meet the same refusal — so it is raised here, where it names the
 * entry, rather than read as an empty file.
 */
async function sizeOf(target: string): Promise<number> {
  try {
    const stats = await fs.lstat(target);
    return stats.size;
  } catch (error) {
    if (isPathAbsentError(error)) return 0;
    throw unstatablePathRefusal(target, error);
  }
}
