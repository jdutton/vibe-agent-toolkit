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

import { type Dirent, promises as fs, lstatSync } from 'node:fs';
import { basename, dirname } from 'node:path';

import { parseCacheDirectory } from '@vibe-agent-toolkit/resources';
import { buildReport, toFindings, type Gate } from '@vibe-agent-toolkit/schema';
import { applyTreePlanOrLeftover, classifyFsFault, isFsFaultError, direntKind, type EntryKind, type FsFaultContext, isPathAbsentError, planTreeChanges, requireConfirmedAbsent, safePath } from '@vibe-agent-toolkit/utils';

import { refusalCodeOf } from '../../utils/command-refusal.js';
import { endWithRefusal, endWithReport, type FinishedWork, leftoverIssueOf, NOTHING_FINISHED } from '../../utils/document-writer.js';
import { createLogger } from '../../utils/logger.js';

import type { CacheClearData } from './clear-schema.js';

/** The one name the shared cache root is allowed to have. See {@link vatCacheRoot}. */
const VAT_CACHE_DIR_NAME = '.vat-cache';

/** `vat cache clear` has no `--strict`, and its only finding is a leftover warning: the gate is fixed. */
const CACHE_CLEAR_GATE: Gate = { strict: false };

/** One location is considered on every run: the shared cache root. */
const CACHE_LOCATIONS_CONSIDERED = 1;

export interface CacheClearOptions {
  debug?: boolean;
}

interface TreeUsage {
  entries: number;
  bytes: number;
}

const EMPTY_USAGE: TreeUsage = { entries: 0, bytes: 0 };

/** What a clear finished: what it removed, and — when the OS would not then delete the tree it moved aside — that failure. */
interface CacheClearOutcome {
  readonly data: CacheClearData;
  /** The moved-aside cache the OS would not delete: a `destination` fault naming where it is. */
  readonly leftover?: unknown;
}

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
 * Measure, then delete, an entire cache tree, as ONE tree-change plan: a `remove`
 * of state VAT owns outright (`vat-state`).
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

/**
 * What the delete will take: the root's top-level names and the whole tree's usage — or `undefined`
 * when the root has really vanished since the plan saw it. A root that is not a directory (a link,
 * a file someone put there) is one entry, never followed: the delete removes the entry itself, and
 * counting a link's target would report a tree it never touches.
 */
async function measureRoot(cacheDir: string, existing: EntryKind): Promise<{ names: string[]; usage: TreeUsage } | undefined> {
  if (existing !== 'directory') return { names: [], usage: { entries: 1, bytes: await sizeOf(cacheDir) } };
  const entries = await listedOrVanished(cacheDir);
  if (entries === null) return undefined;
  return { names: entries.map((entry) => entry.name), usage: await measureEntries(cacheDir, entries) };
}

/** Whether nothing is at `cacheDir` now, believed only when its parent's listing agrees ({@link vanished}). */
function goneNow(cacheDir: string): boolean {
  try {
    lstatSync(cacheDir);
    return false;
  } catch (error) {
    return vanished(error, cacheDir, { side: 'destination', action: 'examine the cache', path: cacheDir });
  }
}

/** Stable ordering for the reported entry lists. */
function sorted(names: readonly string[]): string[] {
  return [...names].sort((left, right) => left.localeCompare(right));
}

/**
 * Command entry point: clear the real cache root and publish the report.
 *
 * A complete clear is `ok` — nothing there to remove included. A refusal before
 * the tree left its path is the envelope's error branch with `data: null`. Once
 * it is off its path the clear is done: a delete the OS then stops is still
 * `RUN_INCOMPLETE`, published with the clear's `data` and a
 * TREE_CLEANUP_INCOMPLETE warning naming where the moved-aside tree is.
 *
 * @param options - Command options (only `--debug`, inherited from the root)
 */
export async function cacheClearCommand(options: CacheClearOptions = {}): Promise<void> {
  const logger = createLogger(options.debug ? { debug: true } : {});

  let outcome: CacheClearOutcome;
  try {
    outcome = await clearCacheDirectory(vatCacheRoot());
  } catch (error) {
    return refuse(error, NOTHING_FINISHED);
  }
  const { data, leftover } = outcome;
  if (leftover !== undefined) return refuse(leftover, { examined: CACHE_LOCATIONS_CONSIDERED, findings: toFindings([leftoverIssueOf(leftover)]), data });
  logger.debug(`Cleared ${String(data.entriesRemoved)} cache entries from ${data.cacheDir}`);
  endWithReport('cache clear', buildReport({ examined: CACHE_LOCATIONS_CONSIDERED, findings: [], data, gate: CACHE_CLEAR_GATE }), 'yaml');
}

/** End on the envelope's error branch: `error` refused, `finished` the work done before it. */
function refuse(error: unknown, finished: FinishedWork): never {
  return endWithRefusal('cache clear', refusalCodeOf(error), error, 'yaml', CACHE_CLEAR_GATE, finished);
}

/**
 * Whether `error`, from a probe of `target`, says it is gone — believed only when the parent's
 * listing agrees (a concurrent run pruning its own entry). An `ENOENT` for an entry the parent
 * still names is a refusal, thrown classified: reading it as "gone" would report a cache that is
 * on disk as cleared, or as never there. Any other error is thrown classified on `ctx`.
 */
function vanished(error: unknown, target: string, ctx: FsFaultContext): true {
  if (!isPathAbsentError(error)) throw classifyFsFault(error, { ...ctx, path: target });
  requireConfirmedAbsent(target, error, ctx, { follows: false });
  return true;
}

/**
 * List `dir`, or `null` when it has really vanished (see {@link vanished}). The cache is VAT's own
 * scratch, so a listing the OS refuses is an `environment` fault.
 */
async function listedOrVanished(dir: string): Promise<Dirent[] | null> {
  const ctx = { side: 'environment', action: 'list the cache', path: dir } as const;
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    vanished(error, dir, ctx);
    return null;
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
      // tree the delete leaves untouched.
      return direntKind(entry) === 'directory' ? measureTree(child) : { entries: 1, bytes: await sizeOf(child) };
    })
  );

  return usages.reduce(
    (total, usage) => ({ entries: total.entries + usage.entries, bytes: total.bytes + usage.bytes }),
    EMPTY_USAGE
  );
}

/** Recursive measure. A directory that really vanished mid-walk contributes nothing. */
async function measureTree(dir: string): Promise<TreeUsage> {
  const entries = await listedOrVanished(dir);
  return entries === null ? EMPTY_USAGE : measureEntries(dir, entries);
}

/**
 * Size of one entry, without following symlinks.
 *
 * A file that really disappeared between the listing and the stat contributes 0
 * rather than failing the clear — the whole tree is about to be deleted anyway,
 * and a concurrent vat run pruning its own temp file must not turn cleanup into an
 * error. Only a DISAPPEARANCE is 0: an entry the OS refuses to stat is still
 * there, still about to be counted as reclaimed — so it is raised here, where it
 * names the entry, rather than read as an empty file.
 */
async function sizeOf(target: string): Promise<number> {
  try {
    const stats = await fs.lstat(target);
    return stats.size;
  } catch (error) {
    vanished(error, target, { side: 'environment', action: 'measure the cache', path: target });
    return 0;
  }
}
