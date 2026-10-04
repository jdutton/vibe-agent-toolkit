/**
 * The one check `vat rag stats`, `query` and `clear` make before acting on a
 * database: that it is there, and that it IS a RAG database. Apart from the
 * command modules, which do not read the filesystem themselves.
 */

import { readdirSync, statSync } from 'node:fs';

import { foreignDatabaseEntries } from '@vibe-agent-toolkit/rag-lancedb';
import { isPathAbsentError, RAG_INDEX_EMPTY_CODE, VatError } from '@vibe-agent-toolkit/utils';

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
 * @returns Its entries
 */
function listDatabase(dbPath: string, explicit: boolean): string[] {
  try {
    return readdirSync(dbPath);
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
 *   or a file, and for a directory holding anything but a RAG database;
 *   `INPUT_UNREADABLE` for a path the OS will not list, or a project `.rag-db` that is a file
 * @throws {VatError} `RAG_INDEX_EMPTY` (`INPUT_UNREADABLE`) when the project
 *   default is absent: nothing has been indexed, the same refusal a query over
 *   an empty index gets
 */
export function requireExistingDatabase(dbPath: string, explicit: boolean): void {
  const foreign = foreignDatabaseEntries(listDatabase(dbPath, explicit));
  if (foreign.length > 0) {
    const named = foreign.slice(0, NAMED_ENTRIES).join(', ');
    const more = foreign.length > NAMED_ENTRIES ? ` and ${foreign.length - NAMED_ENTRIES} more` : '';
    throw new CommandRefusalError(
      'USAGE_INVALID',
      `Not a RAG database: ${dbPath} holds ${named}${more}, which no database vat rag index made would hold. ` +
        'Nothing was read or removed; point --db at the directory vat rag index wrote.',
    );
  }
}
