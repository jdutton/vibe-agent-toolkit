/**
 * The one walk over a tree that is about to be read whole: `proveTreeReadable`
 * runs it to prove a source before anything is written, and `copyTree` runs it to
 * copy that source. One walk, so the proof and the copy can never disagree about
 * which entries exist, which links are followed, or which entries are refused.
 *
 * Every entry is judged by one special-file policy, in this order:
 *
 * - A name the caller's `filter` excludes is skipped before anything touches it:
 *   no `stat`, no `open`, and a directory's subtree is never listed.
 * - A link under `links: 'preserve'` is handed over as a link; its target is never
 *   examined.
 * - A link under `links: 'follow-contained'` is answered by its target (`stat`, so
 *   a dangling link is an absent source). A directory target is entered first, so a
 *   link back into the walk is named as the loop it is
 *   ({@link DirectoryWalkRevisitedError}); then a target outside the root is refused
 *   ({@link CopyLinkEscapesSourceError}).
 * - A named pipe, socket or device (or a link to one) is refused unopened, as the
 *   `EFTYPE` errno `refuseSpecialFile` raises.
 * - A regular file is opened without blocking and judged again by `fstat` on that
 *   handle, which is the one the visitor reads: a pipe swapped in after the listing
 *   is refused there, never waited on.
 *
 * Every READ the walk makes (list, `stat`, `open`, `fstat`, `realpath`) that the OS
 * refuses is a classified fault on the caller's `side`, origin `content`, naming the
 * entry. What a visitor WRITES is the visitor's: the walk never classifies it.
 */

import type { Dirent, Stats } from 'node:fs';
import fs, { type FileHandle } from 'node:fs/promises';

import { classifyFsFault, type FsSide } from '../errors/fs-fault.js';
import { forEachInOrder } from '../in-order.js';
import { isUnderRoot } from '../path-containment.js';
import { safePath } from '../path-core.js';
import { refuseSpecialFile } from '../special-file.js';
import { openForReading } from '../text-file.js';

import { CopyLinkEscapesSourceError, FollowedWalk } from './followed-walk.js';

/** How a walk treats a symlink: follow it, contained to the root, or keep it as a link. */
export type LinkPolicy = 'follow-contained' | 'preserve';

/** What every walk over a tree is told. */
export interface TreeWalkOptions {
  /** `follow-contained`: a link is what it points at, inside the root only. `preserve`: a link is a link. */
  readonly links: LinkPolicy;
  /** Keep the entry at this forward-slash path relative to the root; an excluded one is never touched. Omitted: keep everything. */
  readonly filter?: (relative: string) => boolean;
}

/** One entry the walk accepted: where it is, and where it is relative to the root (`''` for the root). */
interface WalkedEntry {
  readonly path: string;
  readonly relative: string;
}

/** What the walk hands each accepted entry to. */
export interface TreeVisitor {
  /** A directory, before any of its entries. */
  directory(entry: WalkedEntry, stats: Stats): Promise<void>;
  /** A regular file, through the handle `fstat` judged; the walk closes it. */
  file(entry: WalkedEntry, handle: FileHandle, stats: Stats): Promise<void>;
  /** A link under `links: 'preserve'`, never examined. */
  link(entry: WalkedEntry): Promise<void>;
}

/**
 * A refusal by the OS while reading the tree, as a fault on `side` (origin
 * `content`) naming `entry` when the OS named no path. A coded refusal and a defect
 * come back as they are. The one classification every read of the tree goes through.
 */
export function treeReadFault(side: FsSide, entry: string, error: unknown): unknown {
  return classifyFsFault(error, { side, origin: 'content', action: `read ${entry}`, path: entry });
}

/** Run one read of the tree; a refusal is rethrown by {@link treeReadFault}. */
export async function readingTree<T>(side: FsSide, entry: string, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error: unknown) {
    throw treeReadFault(side, entry, error);
  }
}

/** {@link readingTree}, synchronously: the walk guard and the containment check resolve real paths. */
function readingTreeSync<T>(side: FsSide, entry: string, read: () => T): T {
  try {
    return read();
  } catch (error: unknown) {
    throw treeReadFault(side, entry, error);
  }
}

/**
 * Open `path` without blocking and judge it by `fstat` on that handle; hand the
 * handle to `use` and close it after. A special file is refused (`EFTYPE`) and its
 * handle closed before `use` runs. When `use` fails, ITS error is the one reported:
 * the handle is still released, but a close that also fails must not replace a
 * write the visitor failed (a source fault hiding a destination one).
 */
async function withRegularFile(side: FsSide, path: string, use: (handle: FileHandle, stats: Stats) => Promise<void>): Promise<void> {
  const handle = await readingTree(side, path, () => openForReading(path));
  try {
    const stats = await readingTree(side, path, () => handle.stat());
    await use(handle, stats);
  } catch (error: unknown) {
    await Promise.allSettled([handle.close()]);
    throw error;
  }
  // Closing the source's handle is a read of the source: a refused close is the source's fault too.
  await readingTree(side, path, () => handle.close());
}

/** One walk: its root, its policy, the guard a following walk holds, and the visitor. */
class TreeWalk {
  readonly #root: string;
  readonly #options: TreeWalkOptions;
  readonly #side: FsSide;
  readonly #visitor: TreeVisitor;
  readonly #guard: FollowedWalk | undefined;

  constructor(root: string, options: TreeWalkOptions, side: FsSide, visitor: TreeVisitor) {
    this.#root = root;
    this.#options = options;
    this.#side = side;
    this.#visitor = visitor;
    this.#guard = options.links === 'follow-contained' ? new FollowedWalk(side) : undefined;
  }

  /** Enter the directory `entry` and visit it and everything under it, in listing order. */
  async directory(entry: WalkedEntry): Promise<void> {
    // Listed first: a root that is not a directory is refused by the listing (`ENOTDIR`), never opened.
    const listing = await this.#list(entry.path);
    const stats = await readingTree(this.#side, entry.path, () => fs.stat(entry.path));
    this.#enter(entry.path);
    await this.#visitDirectory(entry, listing, stats);
  }

  #list(dir: string): Promise<Dirent[]> {
    return readingTree(this.#side, dir, () => fs.readdir(dir, { withFileTypes: true }));
  }

  /** Visit an entered directory, then its entries in order: the guard must see each directory entered before the walk recurses, and the first refusal names the first offending entry in listing order. */
  async #visitDirectory(entry: WalkedEntry, listing: readonly Dirent[], stats: Stats): Promise<void> {
    await this.#visitor.directory(entry, stats);
    await forEachInOrder(listing, (dirent) => this.#entry(entry, dirent));
  }

  async #entry(parent: WalkedEntry, dirent: Dirent): Promise<void> {
    const entry: WalkedEntry = {
      path: safePath.join(parent.path, dirent.name),
      relative: parent.relative === '' ? dirent.name : `${parent.relative}/${dirent.name}`,
    };
    if (this.#options.filter !== undefined && !this.#options.filter(entry.relative)) return;
    if (dirent.isSymbolicLink()) {
      await this.#link(entry);
      return;
    }
    if (dirent.isDirectory()) {
      await this.directory(entry);
      return;
    }
    await this.#nonDirectory(entry, dirent);
  }

  async #link(entry: WalkedEntry): Promise<void> {
    if (this.#options.links === 'preserve') {
      await this.#visitor.link(entry);
      return;
    }
    const target = await readingTree(this.#side, entry.path, () => fs.stat(entry.path));
    // Revisit first, so a link back into the tree is named as the loop it is; then
    // containment, so a link out is named as the escape it is.
    if (target.isDirectory()) this.#enter(entry.path);
    const contained = readingTreeSync(this.#side, entry.path, () => isUnderRoot(this.#root, entry.path));
    if (contained !== 'inside') throw new CopyLinkEscapesSourceError(entry.path, this.#root);
    if (target.isDirectory()) {
      await this.#visitDirectory(entry, await this.#list(entry.path), target);
      return;
    }
    await this.#nonDirectory(entry, target);
  }

  /** A file by its listing or its link's target: a special one is refused unopened, a regular one opened. */
  async #nonDirectory(entry: WalkedEntry, kind: { isFile(): boolean; isDirectory(): boolean }): Promise<void> {
    readingTreeSync(this.#side, entry.path, () => refuseSpecialFile(kind, entry.path));
    await withRegularFile(this.#side, entry.path, (handle, stats) => this.#visitor.file(entry, handle, stats));
  }

  #enter(dir: string): void {
    const guard = this.#guard;
    guard?.enter(dir);
  }
}

/**
 * Walk the directory `root` under `options`, handing each accepted entry to
 * `visitor` in listing order, the root first (relative `''`).
 *
 * @param root - The directory to walk; one that is not a directory is refused by its listing
 * @param options - The link policy and the filter
 * @param side - The side every read of the walk is classified on
 * @param visitor - What to do with each entry
 */
export async function walkTree(root: string, options: TreeWalkOptions, side: FsSide, visitor: TreeVisitor): Promise<void> {
  await new TreeWalk(root, options, side, visitor).directory({ path: root, relative: '' });
}
