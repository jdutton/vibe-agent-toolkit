/**
 * `copyTree`: copy a directory tree by the same walk `proveTreeReadable` proves it
 * with, reading each file from the very handle the walk judged a regular file.
 */

import nodeFs from 'node:fs';
import fs, { type FileHandle } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';

import { classifyFsFault, type FsSide } from '../errors/fs-fault.js';
import { safePath } from '../path-core.js';
import { openForReading } from '../text-file.js';

import type { ProveTreeReadableOptions } from './readable-tree.js';
import { readingTree, treeReadFault, type TreeVisitor, walkTree } from './tree-walk.js';

/** The owner's read, write and search bits, kept on every copied directory so its owner can always fill and remove it. */
const OWNER_RWX = 0o700;

/** How a refused read of the file being copied is classified: on its side, naming what was read. */
type ReadFault = (error: unknown) => unknown;

/** The bytes of an open file being copied; a read failure is `readFault`'s. A write failure never reaches this catch: the pipeline ends the generator with `return()`, not `throw()`. */
async function* sourceBytes(source: FileHandle, readFault: ReadFault): AsyncGenerator<Buffer> {
  try {
    yield* source.createReadStream({ autoClose: false, start: 0 }) as AsyncIterable<Buffer>;
  } catch (error: unknown) {
    throw readFault(error);
  }
}

/**
 * Copy the bytes of an open file — one already judged a regular file on that very handle — to
 * `into`, and carry its mode over, as `copyFile` does, so a script stays executable. The ONE file
 * copy of the tree copy and the single-file copy.
 */
async function copyOpenFile(handle: FileHandle, into: string, mode: number, readFault: ReadFault): Promise<void> {
  await pipeline(sourceBytes(handle, readFault), nodeFs.createWriteStream(into));
  await fs.chmod(into, mode & 0o7777);
}

/** Writes the copy of each entry the walk accepts under `dest`; every read of the copied tree is on `side`. */
function copyingInto(dest: string, side: FsSide): TreeVisitor {
  const target = (relative: string): string => (relative === '' ? dest : safePath.join(dest, relative));
  return {
    async directory(entry, stats) {
      const into = target(entry.relative);
      await fs.mkdir(into, { recursive: true });
      await fs.chmod(into, (stats.mode & 0o7777) | OWNER_RWX);
    },
    async file(entry, handle, stats) {
      await copyOpenFile(handle, target(entry.relative), stats.mode, (error) => treeReadFault(side, entry.path, error));
    },
    async link(entry) {
      const linkTarget = await readingTree(side, entry.path, () => fs.readlink(entry.path));
      // Verbatim, and untyped: on Windows Node picks `file` or `dir` from the target. A host that
      // cannot make the link (Windows without the privilege: EPERM; a filesystem with none: ENOTSUP)
      // raises the raw errno, a write like any other, for the caller's boundary to classify.
      await fs.symlink(linkTarget, target(entry.relative));
    },
  };
}

/**
 * Copy the directory `source` to `dest` (created, with its parents, when absent).
 *
 * Entries are walked, and refused, exactly as `proveTreeReadable` proves them (see
 * `tree-walk.ts`): a `follow-contained` link is copied as what it points at, inside
 * the source only; a `preserve` link is copied as a link, its target string
 * verbatim and never examined; an entry `filter` excludes is never touched; a named
 * pipe, socket or device is refused unopened. Each file is copied from the handle
 * `fstat` judged, with its mode. Each directory takes its source's mode with the
 * owner's rwx kept (`| 0o700`): a read-only source must not become a copy nothing
 * can fill or remove.
 *
 * The copy names no side for what it WRITES: a failure writing `dest` is the raw
 * errno, for the caller's boundary to classify — a link this host cannot create
 * included. What it READS is on the side the caller names, as the proof's reads
 * are: a refusal is a classified fault on `options.side` (origin `content`) naming
 * the entry. Only the caller knows whether the tree is an input (`source`), VAT's
 * staging (`environment`) or a copy already made into user state (`destination`).
 *
 * @param source - The directory to copy
 * @param dest - Where the copy goes
 * @param options - `links`, `filter` and `side`, exactly as `proveTreeReadable` was given them
 */
export async function copyTree(source: string, dest: string, options: ProveTreeReadableOptions): Promise<void> {
  await walkTree(source, options, options.side, copyingInto(dest, options.side));
}

/** What {@link copyRegularFile} is told about the file it reads. */
export interface CopyRegularFileOptions {
  /** The side of the verb the file is on, as for {@link copyTree}. */
  readonly side: FsSide;
  /** What the file is, for a refused read's message: `read <reading>` (`linked file docs/a.md`). */
  readonly reading: string;
}

/**
 * Copy ONE regular file to `dest` (its directory must exist), as {@link copyTree} copies
 * a file: opened without blocking and judged by `fstat` on that handle (a named pipe,
 * socket or device is refused before a byte is read, never waited on), its bytes copied
 * from that very handle, its mode carried over.
 *
 * Every read is a classified fault on `options.side` (origin `content`), naming what was
 * read; a failure writing `dest` is the raw errno, for the caller's boundary to classify.
 *
 * @param source - The file to copy
 * @param dest - Where the copy goes
 * @param options - The side `source` is on, and what it is
 */
export async function copyRegularFile(source: string, dest: string, options: CopyRegularFileOptions): Promise<void> {
  // Every read — the open, the `fstat`, the stream, the close — names what was read, on its side.
  const readFault: ReadFault = (error) => classifyFsFault(error, { side: options.side, origin: 'content', action: `read ${options.reading}`, path: source });
  const reading = async <T>(read: () => Promise<T>): Promise<T> => {
    try {
      return await read();
    } catch (error: unknown) {
      throw readFault(error);
    }
  };
  const handle = await reading(() => openForReading(source));
  try {
    const stats = await reading(() => handle.stat());
    await copyOpenFile(handle, dest, stats.mode, readFault);
  } catch (error: unknown) {
    // The copy's own failure is the answer: a close refused after it is not a second one.
    await handle.close().catch(() => undefined);
    throw error;
  }
  // The close is a read of the source, too: a refusal of it is on the source's side.
  await reading(() => handle.close());
}
