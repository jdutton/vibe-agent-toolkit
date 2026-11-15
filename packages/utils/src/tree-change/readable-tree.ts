/**
 * The readable-tree proof: before a verb writes anything for a tree it is about to
 * read whole, it proves every entry readable, so an unreadable input is refused as
 * the input it is rather than surfacing half-way through as an output failure.
 */

import type { FsSide } from '../errors/fs-fault.js';
import { openForReading } from '../text-file.js';

import { type TreeVisitor, type TreeWalkOptions, walkTree } from './tree-walk.js';

/** What {@link proveTreeReadable} is told: the walk's link policy and filter, and the side its faults are on. */
export interface ProveTreeReadableOptions extends TreeWalkOptions {
  /**
   * The side of the verb the tree is on: an input (`source`), VAT's staging
   * (`environment`), or a copy already made into user state (`destination`).
   */
  readonly side: FsSide;
}

/** Proving reads nothing past the open: the open, the `fstat` and the listing are the proof. */
const PROVE: TreeVisitor = {
  directory: () => Promise.resolve(),
  file: () => Promise.resolve(),
  link: () => Promise.resolve(),
};

/**
 * Prove the directory `root` readable: every directory listed, every regular file
 * opened without blocking and judged by `fstat` on that handle, each entry held to
 * the one special-file and link policy `copyTree` copies by (see `tree-walk.ts`).
 * A root that is not a directory is refused by its listing (`ENOTDIR`), as
 * `copyTree` refuses it. Each file is opened, never `access`ed: on Windows `access`
 * does not consult ACLs.
 *
 * @param root - The directory the caller is about to read
 * @param options - `links` and `filter` as the read will use them, and the `side` the tree is on
 * @throws FsFaultError on `options.side` (origin `content`) naming the first entry
 *   the OS refused, in listing order — a named pipe, socket or device as class
 *   `wrong-type`; `CopyLinkEscapesSourceError` / `DirectoryWalkRevisitedError` for
 *   a link out of, or back into, a `follow-contained` tree
 */
export async function proveTreeReadable(root: string, options: ProveTreeReadableOptions): Promise<void> {
  await walkTree(root, options, options.side, PROVE);
}

/**
 * Read a regular file whole, through a handle opened without blocking and judged
 * by `fstat` on that handle: a named pipe, socket or device is refused before a
 * byte is read, never waited on.
 *
 * @param path - The file to read
 * @returns Its bytes
 * @throws an `EFTYPE` errno for a special file, `EISDIR` for a directory, and
 *   whatever `open` / `read` throw otherwise — raw, for the caller to classify on
 *   the side it knows the file is on
 */
export async function readRegularFile(path: string): Promise<Buffer> {
  const handle = await openForReading(path);
  try {
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}
