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

/** The chunk table: every indexed chunk and its embedding. */
export const TABLE_NAME = 'rag_chunks';
/** The documents table: one record per indexed resource (`storeDocuments`). */
export const DOCUMENTS_TABLE_NAME = 'rag_documents';

/** LanceDB stores a table as a directory named `<table>.lance` under the database root. */
const DATABASE_ENTRIES: ReadonlySet<string> = new Set([TABLE_NAME, DOCUMENTS_TABLE_NAME].map((table) => `${table}.lance`));

/**
 * The entries of a database directory's listing that no database this
 * provider made would hold.
 *
 * @param entries - The directory's entry names
 * @returns The foreign names, in listing order; empty for a RAG database
 */
export function foreignDatabaseEntries(entries: readonly string[]): string[] {
  return entries.filter((entry) => !DATABASE_ENTRIES.has(entry));
}

/**
 * Remove a RAG database directory, without opening it — so a database whose
 * files are damaged can still be removed.
 *
 * @param dbPath - The database directory
 * @throws {Error} When the directory holds anything a RAG database does not —
 *   nothing is removed then
 */
export function removeRagDatabase(dbPath: string): void {
  if (!fs.existsSync(dbPath)) return;
  const foreign = foreignDatabaseEntries(fs.readdirSync(dbPath));
  if (foreign.length > 0) {
    throw new Error(`Refusing to remove ${dbPath}: it is not a RAG database (it holds ${foreign.join(', ')}).`);
  }
  fs.rmSync(dbPath, { recursive: true, force: true });
}
