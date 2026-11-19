/**
 * What a cache removal will take — measured BEFORE it, because afterwards there
 * is nothing left to count — and the one guard every cache removal stands
 * behind. Shared by `vat cache clear` and `vat cache prune`.
 *
 * Every probe reads the cache as VAT's own scratch: an entry that really
 * vanished mid-walk (a concurrent run pruning its own temp file) contributes
 * nothing, and anything the OS refuses is raised, classified, naming the entry
 * — never read as empty, which would report a cache still on disk as reclaimed.
 */

import { type Dirent, promises as fs, lstatSync } from 'node:fs';

import { parseCacheDirectory, recogniseVatCacheRoot, vatCacheRoot } from '@vibe-agent-toolkit/resources';
import { classifyFsFault, direntKind, everywhere, type EntryKind, type FsFaultContext, isPathAbsentError, requireConfirmedAbsent, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';

import { CommandRefusalError } from '../../utils/command-refusal.js';

/** File count and bytes of a measured tree. */
export interface TreeUsage {
  entries: number;
  bytes: number;
}

const EMPTY_USAGE: TreeUsage = { entries: 0, bytes: 0 };

/**
 * The persistable cache root a clear or prune may delete from — after proving it
 * is VAT's.
 *
 * `vatCacheRoot()` is `VAT_CACHE_DIR` when set, a directory of any name the
 * operator chose, so a name check cannot guard a recursive delete. The guard is
 * `recogniseVatCacheRoot()` (see `cache-root.ts` in `@vibe-agent-toolkit/resources`):
 * the root must hold the `CACHEDIR.TAG` VAT writes into a root it created or
 * found empty — or be the default `<tmpdir>/.vat-cache`, which older releases
 * left untagged — and must never be the filesystem root, the home directory,
 * the temp directory itself, or a directory holding the current directory.
 *
 * The parse cache is also checked to sit inside the root: the layout tie the
 * old name check stood for. If `parseCacheDirectory()` ever stopped being built
 * from the root, the root would no longer be the thing the caches live in, and
 * deleting it would be deleting something else.
 *
 * @returns The root, absolute and forward-slashed
 * @throws {CommandRefusalError} `USAGE_INVALID` when the root is not recognisably VAT's
 * @throws {Error} When the parse cache is not under the root (a defect in VAT)
 */
export function recognisedCacheRoot(): string {
  const root = vatCacheRoot();
  const parseDir = parseCacheDirectory();
  // Lexical, not `isUnderRoot`: that walks the filesystem, and a root the OS will not
  // list must reach the clear, which reports it as the fault it is.
  if (!toForwardSlash(parseDir).startsWith(`${toForwardSlash(root)}/`)) {
    throw new Error(`The parse cache ${parseDir} is not under the cache root ${root}: refusing to delete from the root.`);
  }
  const recognition = recogniseVatCacheRoot(root);
  if (recognition.kind === 'refused') throw new CommandRefusalError('USAGE_INVALID', `Refusing to delete from ${root}: ${recognition.reason}`);
  return root;
}

/**
 * What a removal of `target` will take: its top-level names and the whole tree's
 * usage — or `undefined` when it has really vanished since the plan saw it. A
 * target that is not a directory (a link, a file someone put there) is one
 * entry, never followed: the delete removes the entry itself, and counting a
 * link's target would report a tree it never touches.
 *
 * @param target - The entry about to be removed
 * @param existing - What the plan found there
 * @returns Its top-level names and usage, or `undefined` when it is gone
 */
export async function measureRoot(target: string, existing: EntryKind): Promise<{ names: string[]; usage: TreeUsage } | undefined> {
  if (existing !== 'directory') return { names: [], usage: { entries: 1, bytes: await sizeOf(target) } };
  const entries = await listedOrVanished(target);
  if (entries === null) return undefined;
  return { names: entries.map((entry) => entry.name), usage: await measureEntries(target, entries) };
}

/**
 * Whether nothing is at `target` now, believed only when its parent's listing
 * agrees ({@link vanished}).
 *
 * @param target - The entry a removal was aimed at
 * @returns True when it is gone
 */
export function goneNow(target: string): boolean {
  try {
    lstatSync(target);
    return false;
  } catch (error) {
    return vanished(error, target, { side: 'destination', action: 'examine the cache', path: target });
  }
}

/** Stable ordering for the reported entry lists. */
export function sorted(names: readonly string[]): string[] {
  return [...names].sort((left, right) => left.localeCompare(right));
}

/** Sum two usages. */
export function addUsage(left: TreeUsage, right: TreeUsage): TreeUsage {
  return { entries: left.entries + right.entries, bytes: left.bytes + right.bytes };
}

/**
 * List `dir`, or `null` when it has really vanished (see {@link vanished}). The cache is VAT's own
 * scratch, so a listing the OS refuses is an `environment` fault.
 *
 * @param dir - The directory to list
 * @returns Its entries, or `null` when it is gone
 */
export async function listedOrVanished(dir: string): Promise<Dirent[] | null> {
  const ctx = { side: 'environment', action: 'list the cache', path: dir } as const;
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    vanished(error, dir, ctx);
    return null;
  }
}

/**
 * Whether `error`, from a probe of `target`, says it is gone — believed only when the parent's
 * listing agrees (a concurrent run pruning its own entry). An `ENOENT` for an entry the parent
 * still names is a refusal, thrown classified: reading it as "gone" would report a cache that is
 * on disk as cleared, or as never there. Any other error is thrown classified on `ctx`.
 */
function vanished(error: unknown, target: string, ctx: FsFaultContext): true {
  if (!isPathAbsentError(error)) throw classifyFsFault(error, { ...ctx, path: target });
  requireConfirmedAbsent(target, error, { action: ctx.action, path: target }, { follows: false, sideOf: everywhere(ctx.side) });
  return true;
}

/** Sum file count and bytes over already-listed directory entries. */
async function measureEntries(dir: string, entries: Dirent[]): Promise<TreeUsage> {
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
  return usages.reduce((total, usage) => addUsage(total, usage), EMPTY_USAGE);
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
 * rather than failing the removal. Only a DISAPPEARANCE is 0: an entry the OS
 * refuses to stat is still there, still about to be counted as reclaimed — so it
 * is raised here, where it names the entry, rather than read as an empty file.
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
