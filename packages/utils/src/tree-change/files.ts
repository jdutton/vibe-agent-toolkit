/**
 * The file-level half of the tree-change primitive: the staging names every
 * change sits beside its destination under, the one rename (retried where Windows
 * makes a rename race a scanner), the one removal (a read-only tree included), a
 * whole-file replace that never truncates what it replaces, and a temp directory
 * that is always disposed of.
 */

import type { Stats } from 'node:fs';
import fs from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

import { requireConfirmedAbsent } from '../errors/confirmed-absent.js';
import { isAccessRefusedError, isAlreadyExistsError, isPathAbsentError, isRenameContentionError } from '../errors/errno-table.js';
import { classifyFsFault, isFsFaultError, withFsFault } from '../errors/fs-fault.js';
import { recordSuppressedFault } from '../errors/suppressed-faults.js';
import { mapWithConcurrency } from '../in-order.js';
import { isUnderRoot } from '../path-containment.js';
import { safePath, toForwardSlash } from '../path-core.js';
import { normalizedTmpdir } from '../path-utils.js';

import { entryInTheWayFault, renameRetryDelay, tempDirRefusal } from './apply-decisions.js';
import { stagingName } from './staging-names.js';

/** The owner's read, write and search bits: what a directory needs for its entries to be removed. */
const OWNER_RWX = 0o700;

export { TEMP_DIR_OUTSIDE_TMPDIR_CODE } from './apply-decisions.js';

function renameTrying(from: string, to: string, attempt: number): Promise<void> {
  return fs.rename(from, to).catch(async (error: unknown) => {
    const wait = renameRetryDelay(process.platform, attempt, isRenameContentionError(error));
    if (wait === undefined) throw error;
    await delay(wait);
    return renameTrying(from, to, attempt + 1);
  });
}

/**
 * Rename `from` to `to` — a file or a whole tree — in one step. Under win32 a
 * rename the OS refuses with contention (`EPERM`, `EBUSY`, `EACCES`: a scanner,
 * an indexer, a handle still closing) is retried, up to 6 tries with a backoff of
 * 50·2ⁿ ms (1.55 s in all); any other errno, and any errno on another platform,
 * is final.
 *
 * @param from - The entry to move
 * @param to - Its new name, on the same filesystem
 * @throws the rename's raw errno, for the caller to classify on the side it knows
 */
export function renameFileAtomic(from: string, to: string): Promise<void> {
  return renameTrying(from, to, 0);
}

/**
 * Give `dir` the owner's rwx, then list the directories under it (links not followed). A
 * directory already gone is nothing to grant: `rm`'s recursion removes siblings concurrently and
 * goes on after it has rejected, so the walk can meet one it has just taken.
 */
async function grantOwner(dir: string): Promise<string[]> {
  try {
    await fs.chmod(dir, OWNER_RWX);
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => !entry.isSymbolicLink() && entry.isDirectory()).map((entry) => safePath.join(dir, entry.name));
  } catch (error: unknown) {
    if (isPathAbsentError(error)) return [];
    throw error;
  }
}

/**
 * Give every directory of `level` and below the owner's rwx, each before it is listed: one
 * level at a time, at most `FS_CONCURRENCY` in flight however wide or deep the tree is.
 */
async function grantOwnerWalk(level: readonly string[]): Promise<void> {
  if (level.length === 0) return;
  const next = await mapWithConcurrency(level, grantOwner);
  await grantOwnerWalk(next.flat());
}

/**
 * Remove `entry` — a tree, a file or a link (never what it points at) — whatever
 * the modes under it: the root gets the owner's rwx first, and a removal still
 * refused (`EACCES` / `EPERM`: a read-only directory deeper down refuses the
 * removal of its entries) is retried once every directory under it has been given
 * them too. Nothing there is not a failure. A root the OS will not chmod is still
 * removed when the removal itself is allowed. Done means not there: a removal that
 * resolved with the entry still present (`rm`'s `force` reading its own listing's
 * ENOENT as "gone") is run once more, and a plain `rmdir` then throws why it stays.
 *
 * @throws the raw errno of the chmod, listing or removal that failed
 */
export async function removeEntry(entry: string): Promise<void> {
  if (!(await removeOnce(entry))) return;
  // `rm` with `force` takes an ENOENT from its own listing for "already gone" and resolves with the entry
  // still there: done is what is not there. Once more; then the non-recursive removal names why it stays.
  if (!(await present(entry))) return;
  await removeOnce(entry);
  if (await present(entry)) await fs.rmdir(entry);
}

/**
 * The `lstat` of `entry`, or `undefined` when nothing — a dangling link included — is there. "Nothing
 * there" is believed only when the parent's listing agrees: an `lstat` answering ENOTDIR for a parked
 * tree that WAS there read as "already gone", and the run exited 0 with the tree left behind.
 */
async function examined(entry: string): Promise<Stats | undefined> {
  try {
    return await fs.lstat(entry);
  } catch (error: unknown) {
    if (!isPathAbsentError(error)) throw error;
    requireConfirmedAbsent(entry, error, { side: 'destination', action: 'remove the entry', path: entry }, { follows: false });
    return undefined;
  }
}

/** Whether anything is at `entry` (see {@link examined}); a refusal is thrown. */
async function present(entry: string): Promise<boolean> {
  return (await examined(entry)) !== undefined;
}

/** One removal pass (see {@link removeEntry}); `false` when nothing was there to remove. */
async function removeOnce(entry: string): Promise<boolean> {
  const stats = await examined(entry);
  if (stats === undefined) return false;
  const directory = stats.isDirectory();
  // Best effort: a root the OS will not chmod may still be removable, and the walk below asks again.
  if (directory) await fs.chmod(entry, OWNER_RWX).catch((refused: unknown) => refused);
  try {
    await fs.rm(entry, { recursive: true, force: true });
  } catch (error: unknown) {
    if (!directory || !isAccessRefusedError(error)) throw error;
    await grantOwnerWalk([entry]);
    await fs.rm(entry, { recursive: true, force: true });
  }
  return true;
}

/** Where a write to `dest` really lands: a link's target (so a dotfiles link stays a link), or `dest` itself. */
async function writeTarget(dest: string): Promise<{ path: string; mode: number | undefined }> {
  try {
    const real = toForwardSlash(await fs.realpath(dest));
    return { path: real, mode: (await fs.stat(real)).mode & 0o7777 };
  } catch (error: unknown) {
    if (isPathAbsentError(error)) return { path: dest, mode: undefined };
    throw error;
  }
}

/**
 * Prove an existing file writable as it is, by opening it for writing — no truncation, no
 * creation — and closing it. A rename over a file needs only its directory's permission, so
 * without this a file its owner made read-only (or Windows marked read-only) would be replaced
 * where a write in place is refused. An open, not `access`: on Windows `access` does not consult ACLs.
 */
async function proveWritable(file: string): Promise<void> {
  const handle = await fs.open(file, 'r+');
  await handle.close();
}

/**
 * Replace the file `dest` with `contents` in one step: the bytes go to a temp
 * name beside it, which is then renamed over it ({@link renameFileAtomic}). A
 * write that fails — a full disk mid-write — leaves `dest` byte-equal and the
 * temp removed (a temp that will not go is recorded beside the thrown error:
 * `suppressedFaultsOf`). An existing file keeps its mode, and must be writable as it is: one
 * a write in place would be refused (a read-only file) is refused before anything is written,
 * never replaced by the rename. A link is written through, so it stays a link to the replaced file.
 *
 * @param dest - The file to replace or create
 * @param contents - Its new bytes
 * @throws the raw errno, for the caller to classify on the side it knows
 */
export async function replaceFile(dest: string, contents: string | Uint8Array): Promise<void> {
  const target = await writeTarget(dest);
  if (target.mode !== undefined) await proveWritable(target.path);
  const temp = stagingName(target.path);
  try {
    const handle = await fs.open(temp, 'wx');
    try {
      await handle.writeFile(contents);
    } finally {
      await handle.close();
    }
    if (target.mode !== undefined) await fs.chmod(temp, target.mode);
    await renameFileAtomic(temp, target.path);
  } catch (error: unknown) {
    await fs.rm(temp, { force: true }).catch((cleanup: unknown) => {
      recordSuppressedFault(error, classifyFsFault(cleanup, { side: 'destination', action: 'remove the temporary file', path: temp }));
    });
    throw error;
  }
}

/** What is at `path`, never following a link; `undefined` when nothing is. A refusal is thrown raw. */
async function entryAt(path: string): Promise<Stats | undefined> {
  try {
    return await fs.lstat(path);
  } catch (error: unknown) {
    if (isPathAbsentError(error)) return undefined;
    throw error;
  }
}

/**
 * The directory `segments` name under `dir`, each component a REAL directory: made (a plain `mkdir`)
 * when absent, refused when a link or a file stands there. One component at a time — each must be a
 * directory before the next is looked at.
 */
async function plainDirectoryUnder(dir: string, segments: readonly string[], writing: string): Promise<string> {
  const [segment, ...rest] = segments;
  if (segment === undefined) return dir;
  const next = safePath.join(dir, segment);
  const there = await entryAt(next);
  if (there === undefined) await fs.mkdir(next);
  else if (!there.isDirectory()) throw entryInTheWayFault(next, writing, undefined);
  return plainDirectoryUnder(next, rest, writing);
}

/** The components of `relative`, a path under a tree's root. A `..` would leave the tree: a defect in the caller. */
function segmentsUnderRoot(relative: string): string[] {
  const segments = toForwardSlash(relative).split('/').filter((segment) => segment.length > 0 && segment !== '.');
  if (segments.includes('..')) throw new TypeError(`"${relative}" is not a path under the tree's root`);
  return segments;
}

/**
 * Make the directory `relative` under `root` — a tree VAT is building, which may hold whatever its
 * source shipped, links included — without ever going through a link: every component must be a real
 * directory (adopted when there, made by a plain `mkdir` when absent). What a recursive `mkdir`
 * would do instead is follow a link standing where a component goes, out of the tree.
 *
 * @param root - The tree's root, which the caller made
 * @param relative - The directory, relative to `root`, forward slashes
 * @param writing - What the directory is for, for a refusal's message
 * @returns The directory's path
 * @throws FsFaultError side `source`, origin `content`, class `occupied`, naming the link or file
 *   standing where a directory goes; any other failure is the raw errno
 */
export async function makeDirectoryUnder(root: string, relative: string, writing: string): Promise<string> {
  return await plainDirectoryUnder(root, segmentsUnderRoot(relative), writing);
}

/**
 * Write a file VAT makes into a tree it is building — a staged tree that may hold whatever its source
 * shipped, links included — without ever writing over or through what is already there.
 *
 * Every directory of `relative` under `root` must be a real directory (a link standing where one goes
 * would carry the write outside the tree); a missing one is made by a plain `mkdir`. The file itself
 * is created exclusively (`wx`, which no link satisfies). What `existing` decides is only the entry
 * AT the file's name:
 * - `refuse`: anything there refuses the write.
 * - `replace`: a regular file there is removed first (VAT's own earlier output, or a file the source
 *   shipped that VAT's supersedes); a link or a directory still refuses.
 *
 * @param root - The tree's root, which the caller made
 * @param relative - The file, relative to `root`, forward slashes
 * @param contents - Its bytes
 * @param options - `existing`, and `writing`: what the file is, for a refusal's message
 * @throws FsFaultError side `source`, origin `content`, class `occupied`, naming the entry in the
 *   way; any other failure is the raw errno, for the caller's boundary to classify
 */
export async function writeFileUnder(
  root: string,
  relative: string,
  contents: string | Uint8Array,
  options: { readonly existing: 'refuse' | 'replace'; readonly writing: string },
): Promise<void> {
  const segments = segmentsUnderRoot(relative);
  const name = segments.at(-1);
  if (name === undefined) throw new TypeError(`writeFileUnder: "${relative}" names no file`);
  const target = safePath.join(await plainDirectoryUnder(root, segments.slice(0, -1), options.writing), name);
  if (options.existing === 'replace') {
    const there = await entryAt(target);
    if (there?.isFile() === true) await fs.unlink(target);
  }
  try {
    await fs.writeFile(target, contents, { flag: 'wx' });
  } catch (error: unknown) {
    throw isAlreadyExistsError(error) ? entryInTheWayFault(target, options.writing, error) : error;
  }
}

/** The classified fault disposing of `dir` raised, or `undefined` once it is gone. A non-filesystem error is a defect and propagates. */
async function disposalFault(dir: string): Promise<unknown> {
  try {
    await removeEntry(dir);
    return undefined;
  } catch (error: unknown) {
    // The action names the directory: what is left is all of it, while the errno may name an entry deep inside.
    const fault = classifyFsFault(error, { side: 'environment', action: `remove the temporary directory ${dir}`, path: dir });
    if (!isFsFaultError(fault)) throw error;
    return fault;
  }
}

/**
 * Remove a temporary directory, its modes notwithstanding — only one strictly
 * under the temp directory (`normalizedTmpdir()`): this removal makes a read-only
 * tree writable before it deletes it, so a wrong argument (an empty string, a
 * project directory) must be refused before anything is touched. A directory
 * elsewhere that VAT owns goes through a `remove` plan.
 *
 * @param dir - The directory
 * @returns `undefined` when it is gone (or was never there); otherwise the leftover: the
 *   classified fault (an `FsFaultError`, side `environment`) whose message names the directory,
 *   for the caller to report as the one `TREE_CLEANUP_INCOMPLETE` warning beside its work
 * @throws VatError {@link TEMP_DIR_OUTSIDE_TMPDIR_CODE} — a defect in the caller — for a
 *   directory not strictly under the temp directory, with nothing removed
 */
export async function disposeTempDir(dir: string): Promise<unknown> {
  refuseOutsideTmpdir(dir);
  return await disposalFault(dir);
}

/** Refuse (a defect in the caller) a directory to dispose of that is not strictly under the temp directory. */
function refuseOutsideTmpdir(dir: string): void {
  const tmp = normalizedTmpdir();
  const refusal = tempDirRefusal(dir, toForwardSlash(tmp), isUnderRoot(tmp, dir));
  if (refusal !== undefined) throw refusal;
}

/**
 * Dispose of a temporary directory because the work that owned it failed — for a directory
 * whose lifetime is not one call (one handed back to the caller on success, removed only on
 * failure), where {@link withTempDir} cannot hold it. The failure stays the answer: a
 * disposal fault is recorded beside it (`suppressedFaultsOf`), never thrown in its place.
 *
 * @param dir - The directory, strictly under the temp directory
 * @param failure - What the work threw; the caller rethrows it
 * @throws VatError {@link TEMP_DIR_OUTSIDE_TMPDIR_CODE} — a defect in the caller — for a
 *   directory not strictly under the temp directory, with nothing removed
 */
export async function disposeTempDirAfterFailure(dir: string, failure: unknown): Promise<void> {
  refuseOutsideTmpdir(dir);
  const fault = await disposalFault(dir);
  if (fault !== undefined) recordSuppressedFault(failure, fault);
}

/** What {@link withTempDir} hands back once its work SUCCEEDED: the work's value, and what the disposal left. */
export interface TempDirOutcome<T> {
  /** What `work` returned. */
  readonly value: T;
  /**
   * `undefined` when the directory went; otherwise the classified fault (an `FsFaultError`, side
   * `environment`, its message naming the directory) of a directory the OS would not remove. The
   * work is DONE: this is never its refusal, but the one `TREE_CLEANUP_INCOMPLETE` warning a verb
   * reports beside the work it finished.
   */
  readonly leftover: unknown;
}

/**
 * Run `work` in a fresh directory under the temp dir (`normalizedTmpdir()`), and
 * dispose of it after, whatever happened.
 *
 * The work's error always wins: rethrown unchanged — never wrapped, never given a
 * cause, never mutated — with a disposal failure recorded beside it
 * (`suppressedFaultsOf`), so a report still names the directory left behind.
 * When the work succeeded, nothing is thrown: the value comes back with the
 * disposal's `leftover` (see {@link TempDirOutcome}), for the caller to report.
 *
 * @param prefix - `mkdtemp` prefix, so a leaked directory names its owner
 * @param work - Given the directory's forward-slash path
 */
export async function withTempDir<T>(prefix: string, work: (dir: string) => Promise<T>): Promise<TempDirOutcome<T>> {
  const tmp = normalizedTmpdir();
  const dir = toForwardSlash(await withFsFault({ side: 'environment', action: 'create a temporary directory', path: tmp }, () => fs.mkdtemp(safePath.join(tmp, prefix))));
  let value: T;
  try {
    value = await work(dir);
  } catch (error: unknown) {
    await disposeTempDirAfterFailure(dir, error);
    throw error;
  }
  return { value, leftover: await disposalFault(dir) };
}
