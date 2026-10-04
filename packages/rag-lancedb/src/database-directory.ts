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

import { isFilesystemAccessError, RAG_DATABASE_NOT_REMOVABLE_CODE, RAG_DATABASE_REMOVAL_INCOMPLETE_CODE, VatError } from '@vibe-agent-toolkit/utils';

/** The chunk table: every indexed chunk and its embedding. */
export const TABLE_NAME = 'rag_chunks';
/** The documents table: one record per indexed resource (`storeDocuments`). */
export const DOCUMENTS_TABLE_NAME = 'rag_documents';

/** LanceDB stores a table as a directory named `<table>.lance` under the database root. */
const DATABASE_ENTRIES: ReadonlySet<string> = new Set([TABLE_NAME, DOCUMENTS_TABLE_NAME].map((table) => `${table}.lance`));

/**
 * Files an operating system writes into any folder a person opens or copies —
 * Finder's `.DS_Store` and AppleDouble `._*` files, Explorer's `Thumbs.db` and
 * `desktop.ini`. Their presence says nothing about whose directory it is.
 */
function isOsLitter(entry: string): boolean {
  return entry === '.DS_Store' || entry === 'Thumbs.db' || entry === 'desktop.ini' || entry.startsWith('._');
}

/**
 * The entries of a database directory's listing that no database this
 * provider made would hold. Operating-system litter is not foreign.
 *
 * @param entries - The directory's entry names
 * @returns The foreign names, in listing order; empty for a RAG database
 */
export function foreignDatabaseEntries(entries: readonly string[]): string[] {
  return entries.filter((entry) => !DATABASE_ENTRIES.has(entry) && !isOsLitter(entry));
}

/**
 * Remove a RAG database directory, without opening it — so a database whose
 * files are damaged can still be removed.
 *
 * @param dbPath - The database directory
 * @throws {VatError} `RAG_DATABASE_NOT_REMOVABLE` when the path is a symbolic
 *   link (removing it would leave the index it names in place) or the directory
 *   holds anything a RAG database does not — nothing is removed then;
 *   `RAG_DATABASE_REMOVAL_INCOMPLETE` when the OS stopped the removal partway
 */
export function removeRagDatabase(dbPath: string): void {
  if (!fs.existsSync(dbPath)) return;
  if (fs.lstatSync(dbPath).isSymbolicLink()) {
    throw new VatError(
      RAG_DATABASE_NOT_REMOVABLE_CODE,
      `Refusing to remove ${dbPath}: it is a symbolic link to ${fs.realpathSync(dbPath)}, and removing the link would leave that database in place. Name the database directory itself.`,
    );
  }
  const foreign = foreignDatabaseEntries(fs.readdirSync(dbPath));
  if (foreign.length > 0) {
    throw new VatError(RAG_DATABASE_NOT_REMOVABLE_CODE, `Refusing to remove ${dbPath}: it is not a RAG database (it holds ${foreign.join(', ')}).`);
  }
  try {
    fs.rmSync(dbPath, { recursive: true, force: true });
  } catch (error) {
    if (!isFilesystemAccessError(error)) throw error;
    throw new VatError(
      RAG_DATABASE_REMOVAL_INCOMPLETE_CODE,
      `Could not finish removing the RAG database at ${dbPath}; part of it may already be gone. Make it writable and clear it again: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
