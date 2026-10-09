/**
 * What a RAG database directory this provider made holds — and the one way to
 * remove one, which refuses a directory holding anything else.
 *
 * A database is a directory of LanceDB tables, one `<table>.lance` directory
 * per table, and this provider writes exactly two tables. An index of nothing
 * leaves the directory EMPTY (opening a path creates it and no table is ever
 * written), so emptiness is a database too. Anything else in the directory is
 * not ours: a recursive removal must not take it.
 */

import fs from 'node:fs';

import { applyTreePlanOrLeftover, fsFaultOf, isPathAbsentError, type OwnershipVerdict, planTreeChanges, safePath, toForwardSlash, withFsFaultSync } from '@vibe-agent-toolkit/utils';

/** The chunk table: every indexed chunk and its embedding. */
export const TABLE_NAME = 'rag_chunks';
/** The documents table: one record per indexed resource (`storeDocuments`). */
export const DOCUMENTS_TABLE_NAME = 'rag_documents';

/** LanceDB stores a table as a directory named `<table>.lance` under the database root. */
const DATABASE_ENTRIES: ReadonlySet<string> = new Set([TABLE_NAME, DOCUMENTS_TABLE_NAME].map((table) => `${table}.lance`));

/** One entry of a directory listing, as `readdirSync(dir, { withFileTypes: true })` gives it. */
export interface DatabaseDirectoryEntry {
  readonly name: string;
  /** True for a regular file only: a directory or a symbolic link (followed or not) is not one. */
  isFile(): boolean;
}

/**
 * Files an operating system writes into any folder a person opens or copies,
 * by name, with the bytes each one starts with: Finder's `.DS_Store` (a "Bud1"
 * buddy allocator) and AppleDouble `._*` files, Explorer's `Thumbs.db` (an OLE
 * compound file). Their presence says nothing about whose directory it is. A
 * NAME alone is not proof — `._notes` is a name a person can give a file — so a
 * file is litter only when it starts with its signature. `desktop.ini` is plain
 * INI text with no signature, so its name and being a regular file is the rule.
 */
const DS_STORE_SIGNATURE = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x42, 0x75, 0x64, 0x31]);
const APPLE_DOUBLE_SIGNATURE = Buffer.from([0x00, 0x05, 0x16, 0x07]);
const OLE_COMPOUND_FILE_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const NO_SIGNATURE = Buffer.alloc(0);

/**
 * The signature a litter file of this name starts with.
 *
 * @returns The bytes (empty for a litter name with no signature), or undefined
 *   for a name the OS never writes as litter
 */
function litterSignature(name: string): Buffer | undefined {
  if (name === '.DS_Store') return DS_STORE_SIGNATURE;
  if (name === 'Thumbs.db') return OLE_COMPOUND_FILE_SIGNATURE;
  if (name === 'desktop.ini') return NO_SIGNATURE;
  if (name.startsWith('._')) return APPLE_DOUBLE_SIGNATURE;
  return undefined;
}

/**
 * Whether the file at `filePath` starts with `signature`, reading only that
 * many bytes. A file that cannot be opened or read is not proven litter.
 */
function startsWithSignature(filePath: string, signature: Buffer): boolean {
  if (signature.length === 0) return true;
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, 'r');
    const head = Buffer.alloc(signature.length);
    return fs.readSync(fd, head, 0, signature.length, 0) === signature.length && head.equals(signature);
  } catch (error) {
    if (fsFaultOf(error) !== undefined) return false;
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * The OS only ever writes litter as regular files: a directory or a link
 * carrying one of these names is the user's, and makes the directory not a
 * database. Only a regular file is opened, so a FIFO is never read.
 */
function isOsLitter(dbPath: string, entry: DatabaseDirectoryEntry): boolean {
  const signature = litterSignature(entry.name);
  if (signature === undefined || !entry.isFile()) return false;
  return startsWithSignature(safePath.join(dbPath, entry.name), signature);
}

/**
 * The entries of a database directory's listing that no database this
 * provider made would hold. Operating-system litter is not foreign.
 *
 * @param dbPath - The directory listed: a litter-named file's first bytes are
 *   read from it to tell litter from a user's file of the same name
 * @param entries - The directory's typed listing (`withFileTypes: true`, which
 *   reports a symbolic link as a link, not as what it names)
 * @returns The foreign names, in listing order; empty for a RAG database
 */
export function foreignDatabaseEntries(dbPath: string, entries: readonly DatabaseDirectoryEntry[]): string[] {
  return entries.filter((entry) => !DATABASE_ENTRIES.has(entry.name) && !isOsLitter(dbPath, entry)).map((entry) => entry.name);
}

/**
 * Where a database path that is a symbolic link really leads (absolute; a dangling link resolves
 * as far as its own target): what a caller names to clear the database itself.
 *
 * @returns The real path, or `undefined` when `dbPath` is not a link (or not there)
 * @throws {FsFaultError} (side `destination`) when the OS refuses to examine the link or its target
 */
export function linkedDatabasePath(dbPath: string): string | undefined {
  const fault = { side: 'destination', path: dbPath, action: 'examine the link at the RAG database path' } as const;
  return withFsFaultSync(fault, () => {
    let stats;
    try {
      stats = fs.lstatSync(dbPath);
    } catch (error: unknown) {
      if (isPathAbsentError(error)) return undefined;
      throw error;
    }
    if (!stats.isSymbolicLink()) return undefined;
    try {
      return toForwardSlash(fs.realpathSync.native(dbPath));
    } catch (error: unknown) {
      // Dangling: name where it points, absolute.
      if (isPathAbsentError(error)) return safePath.resolve(safePath.join(dbPath, '..'), fs.readlinkSync(dbPath));
      throw error;
    }
  });
}

/**
 * Whether `dbPath`, which is there, is a database this provider made: the
 * ownership `removeRagDatabase`'s plan judges it by. Never a link — removing
 * the link would leave the database it names in place — never anything but a
 * directory, and never a directory holding anything a database does not.
 *
 * @throws {FsFaultError} (side `destination`) when the OS refuses to examine or list it
 */
function recogniseRagDatabase(dbPath: string): OwnershipVerdict {
  // The database is the user state the removal writes: a refusal examining it is a destination fault.
  const fault = { side: 'destination', path: dbPath } as const;
  const real = linkedDatabasePath(dbPath);
  if (real !== undefined) {
    return { owned: false, reason: `it is a symbolic link to ${real}, and removing the link would leave that database in place; name the database directory itself` };
  }
  const stats = withFsFaultSync({ ...fault, action: 'examine the RAG database to remove' }, () => fs.lstatSync(dbPath));
  if (!stats.isDirectory()) return { owned: false, reason: 'it is not a directory, so it is not a RAG database' };
  const foreign = foreignDatabaseEntries(dbPath, withFsFaultSync({ ...fault, action: 'list the RAG database to remove' }, () => fs.readdirSync(dbPath, { withFileTypes: true })));
  return foreign.length === 0 ? { owned: true } : { owned: false, reason: `it is not a RAG database (it holds ${foreign.join(', ')})` };
}

/** What a removal finished with. */
export interface RagDatabaseRemoval {
  /** Absent when the database is gone; else the clear is done but the OS would not delete the moved-aside database: an `FsFaultError` (side `destination`) naming where it now is. */
  readonly leftover?: unknown;
}

/**
 * Remove a RAG database directory, without opening it — so a database whose
 * files are damaged can still be removed. One tree-change plan: the database
 * is moved off its path whole, then removed, so a removal the OS stops never
 * leaves part of a database at `dbPath`. Nothing there is nothing to do.
 *
 * @returns The removal: a `leftover` when the moved-aside database could not then be deleted
 * @throws {VatError} `TREE_DEST_NOT_OWNED`, nothing removed, when the path is a link, not a directory, or holds anything a RAG database does not
 * @throws {FsFaultError} (side `destination`), nothing removed, when the OS refuses to examine the database or to move it off its path
 */
export async function removeRagDatabase(dbPath: string): Promise<RagDatabaseRemoval> {
  const plan = await planTreeChanges([{ op: 'remove', dest: dbPath, ownership: { kind: 'vat-made', recognise: recogniseRagDatabase }, label: 'RAG database' }]);
  const { leftover } = await applyTreePlanOrLeftover(plan);
  return leftover === undefined ? {} : { leftover };
}
