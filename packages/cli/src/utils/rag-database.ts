/**
 * The one check `vat rag stats`, `query` and `clear` make before opening a
 * database: that it is there to open. Apart from the command modules, which do
 * not read the filesystem themselves.
 */

import { readdirSync } from 'node:fs';

import { isPathAbsentError, RAG_INDEX_EMPTY_CODE, VatError } from '@vibe-agent-toolkit/utils';

import { CommandRefusalError } from './command-refusal.js';
import { unstatablePathRefusal } from './project-root-policy.js';

/**
 * Refuse a database that is not there to open, before anything opens it.
 *
 * `stats`, `query` and `clear` act on a database `vat rag index` made. Opening
 * a path creates it, so a mistyped `--db` used to leave a new directory behind
 * and publish `ok` — zero chunks, or `cleared: true` — for a database that never
 * existed. Listing it first is the whole check: it answers absent, not a
 * directory, and unreadable in one call.
 *
 * @param dbPath - The resolved database path
 * @param explicit - Whether `--db` named it; otherwise it is the project default
 * @throws {CommandRefusalError} `USAGE_INVALID` for a `--db` that names nothing
 *   or names a file; `INPUT_UNREADABLE` for a path the OS will not list
 * @throws {VatError} `RAG_INDEX_EMPTY` (`INPUT_UNREADABLE`) when the project
 *   default is absent: nothing has been indexed, the same refusal a query over
 *   an empty index gets
 */
export function requireExistingDatabase(dbPath: string, explicit: boolean): void {
  try {
    readdirSync(dbPath);
  } catch (error) {
    if (!explicit && isPathAbsentError(error)) {
      throw new VatError(RAG_INDEX_EMPTY_CODE, `No data indexed yet: there is no RAG database at ${dbPath}. Run vat rag index first.`, { cause: error });
    }
    if ((error as NodeJS.ErrnoException).code === 'ENOTDIR') {
      throw new CommandRefusalError('USAGE_INVALID', `Not a RAG database: ${dbPath} is not a directory.`, { cause: error });
    }
    throw unstatablePathRefusal(dbPath, error);
  }
}
