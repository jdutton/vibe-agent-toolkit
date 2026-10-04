/**
 * The one check every `vat rag` verb makes before acting on a database: that it
 * IS a RAG database — and, for `stats`, `query` and `clear`, that it is there.
 * Apart from the command modules, which do not read the filesystem themselves.
 */

import { accessSync, constants, lstatSync, readdirSync, statSync } from 'node:fs';

import { foreignDatabaseEntries, type DatabaseDirectoryEntry } from '@vibe-agent-toolkit/rag-lancedb';
import { isFilesystemAccessError, isPathAbsentError, mkdirSyncReal, normalizePath, RAG_INDEX_EMPTY_CODE, safePath, VatError } from '@vibe-agent-toolkit/utils';

import { CommandRefusalError } from './command-refusal.js';
import { unstatablePathRefusal } from './project-root-policy.js';

/** How many foreign entries a refusal names before it summarises the rest. */
const NAMED_ENTRIES = 5;

/**
 * Why a path that would not list is not a directory: it is a file itself, or
 * something above it is (`readdir` says ENOTDIR for both).
 *
 * @param dbPath - The path `readdir` refused with ENOTDIR
 * @returns The sentence naming which
 */
function notADirectory(dbPath: string): string {
  try {
    statSync(dbPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOTDIR') return `a path above ${dbPath} is not a directory`;
    throw unstatablePathRefusal(dbPath, error);
  }
  return `${dbPath} is not a directory`;
}

/**
 * List the database directory, refusing a path that is not one.
 *
 * @param dbPath - The resolved database path
 * @param explicit - Whether `--db` named it
 * @returns Its typed entries
 */
function listDatabase(dbPath: string, explicit: boolean): DatabaseDirectoryEntry[] {
  try {
    return readdirSync(dbPath, { withFileTypes: true });
  } catch (error) {
    const errno = (error as NodeJS.ErrnoException).code;
    if (errno === 'ENOTDIR') {
      // A --db naming a file is the invocation's mistake; the project's own `.rag-db` being one is its state.
      throw new CommandRefusalError(explicit ? 'USAGE_INVALID' : 'INPUT_UNREADABLE', `Not a RAG database: ${notADirectory(dbPath)}.`, { cause: error });
    }
    if (!explicit && isPathAbsentError(error)) {
      throw new VatError(RAG_INDEX_EMPTY_CODE, `No data indexed yet: there is no RAG database at ${dbPath}. Run vat rag index first.`, { cause: error });
    }
    throw unstatablePathRefusal(dbPath, error);
  }
}

/**
 * Refuse a path that is not a RAG database, before anything opens or removes it.
 *
 * `stats`, `query` and `clear` act on a database `vat rag index` made. Opening
 * a path creates it, so a mistyped `--db` used to leave a new directory behind
 * and publish `ok`; and `clear` removes recursively, so a `--db` naming any
 * other directory — the project, `$HOME` — used to be deleted with
 * `cleared: true`. A database is a directory holding only VAT's LanceDB tables
 * (or nothing, after an index of nothing); anything else is refused.
 *
 * @param dbPath - The resolved database path
 * @param explicit - Whether `--db` named it; otherwise it is the project default
 * @throws {CommandRefusalError} `USAGE_INVALID` for a `--db` that names nothing
 *   or a file, and for a `--db` directory holding anything but a RAG database
 *   (operating-system litter such as `.DS_Store` aside); `INPUT_UNREADABLE` for
 *   a path the OS will not list, or a project `.rag-db` that is a file or holds
 *   anything else
 * @throws {VatError} `RAG_INDEX_EMPTY` (`INPUT_UNREADABLE`) when the project
 *   default is absent: nothing has been indexed, the same refusal a query over
 *   an empty index gets
 */
export function requireExistingDatabase(dbPath: string, explicit: boolean): void {
  refuseForeignEntries(dbPath, listDatabase(dbPath, explicit), explicit, 'Nothing was read or removed', 'the directory vat rag index wrote');
}

/**
 * Refuse a database directory listing anything a database `vat rag index` made
 * would not hold.
 *
 * @param dbPath - The resolved database path
 * @param entries - Its typed listing
 * @param explicit - Whether `--db` named it; otherwise it is the project default
 * @param untouched - What the refusal left alone, the sentence that opens its fix
 * @param wanted - What a `--db` should name instead
 * @throws {CommandRefusalError} `USAGE_INVALID` for a `--db`, `INPUT_UNREADABLE`
 *   for the project's own `.rag-db`
 */
function refuseForeignEntries(dbPath: string, entries: readonly DatabaseDirectoryEntry[], explicit: boolean, untouched: string, wanted: string): void {
  const foreign = foreignDatabaseEntries(entries);
  if (foreign.length === 0) return;
  const named = foreign.slice(0, NAMED_ENTRIES).join(', ');
  const more = foreign.length > NAMED_ENTRIES ? ` and ${foreign.length - NAMED_ENTRIES} more` : '';
  // A --db naming the wrong directory is the invocation's mistake; the project's own
  // `.rag-db` holding something else is the project's state — no --db was given to fix.
  throw new CommandRefusalError(
    explicit ? 'USAGE_INVALID' : 'INPUT_UNREADABLE',
    `Not a RAG database: ${dbPath} holds ${named}${more}, which no database vat rag index made would hold. ` +
      (explicit
        ? `${untouched}; point --db at ${wanted}.`
        : `${untouched}; move those entries out of the project's .rag-db, or name another database with --db.`),
  );
}

/**
 * Refuse a database path that is a symbolic link, before it is removed:
 * removing the link would leave the database it names in place while the run
 * reported it cleared.
 *
 * @param dbPath - The resolved database path, already recognised as a database
 * @param explicit - Whether `--db` named it; otherwise it is the project default
 * @throws {CommandRefusalError} `USAGE_INVALID` for a `--db` link, naming the
 *   real path; `INPUT_UNREADABLE` for a project `.rag-db` that is one
 */
export function refuseLinkedDatabase(dbPath: string, explicit: boolean): void {
  if (!lstatSync(dbPath).isSymbolicLink()) return;
  const real = normalizePath(safePath.resolve(dbPath));
  throw new CommandRefusalError(
    explicit ? 'USAGE_INVALID' : 'INPUT_UNREADABLE',
    `Not removed: ${dbPath} is a symbolic link to ${real}, and removing the link would leave that database in place. ` +
      `Run vat rag clear --db ${real} to clear the database itself.`,
  );
}

/**
 * Make sure `vat rag index` can write its database at `dbPath`, before LanceDB
 * is handed the path: one that cannot hold a database is the caller's input, and
 * one the OS will not let the run write is the run not finishing — neither is a
 * defect in VAT, which is what LanceDB's own failure for either read as.
 *
 * @param dbPath - The resolved database path
 * @param explicit - Whether `--db` named it; otherwise it is the project default
 * @throws {CommandRefusalError} `USAGE_INVALID` for a `--db` that is (or lies
 *   under) a file or a directory holding anything a RAG database does not,
 *   `INPUT_UNREADABLE` for a project `.rag-db` that is either, or a path the OS
 *   will not examine or list; `RUN_INCOMPLETE` for a database directory the run
 *   cannot create or write
 */
export function requireWritableDatabase(dbPath: string, explicit: boolean): void {
  const inputRefusal = explicit ? 'USAGE_INVALID' : 'INPUT_UNREADABLE';
  let isDirectory: boolean;
  try {
    isDirectory = statSync(dbPath).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOTDIR') {
      throw new CommandRefusalError(inputRefusal, `Cannot index into ${dbPath}: a path above it is not a directory.`, { cause: error });
    }
    if (!isPathAbsentError(error)) throw unstatablePathRefusal(dbPath, error);
    writingDatabase(dbPath, 'create', () => mkdirSyncReal(dbPath, { recursive: true }));
    return;
  }
  if (!isDirectory) {
    throw new CommandRefusalError(inputRefusal, `Cannot index into ${dbPath}: it is not a directory, so it cannot hold a RAG database.`);
  }
  // LanceDB writes its tables into whatever directory it is handed: `--db .` filled the project root.
  refuseForeignEntries(dbPath, listDatabase(dbPath, explicit), explicit, 'Nothing was indexed', 'a RAG database, an empty directory or a path that does not exist yet');
  writingDatabase(dbPath, 'write into', () => accessSync(dbPath, constants.W_OK));
}

/** Run a write probe of the database directory; an OS refusal is the run not finishing. */
function writingDatabase(dbPath: string, what: string, probe: () => unknown): void {
  try {
    probe();
  } catch (error) {
    if (!isFilesystemAccessError(error)) throw error;
    throw new CommandRefusalError(
      'RUN_INCOMPLETE',
      `Could not ${what} the RAG database directory ${dbPath} (${(error as NodeJS.ErrnoException).code ?? 'unknown error'}); nothing was indexed. Check that it, or its parent, is writable.`,
      { cause: error },
    );
  }
}
