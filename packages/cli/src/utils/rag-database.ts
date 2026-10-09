/**
 * The one check every `vat rag` verb makes before acting on a database: that it
 * IS a RAG database — and, for `stats`, `query` and `clear`, that it is there.
 * Apart from the command modules, which do not read the filesystem themselves.
 */

import { accessSync, constants, readdirSync, statSync } from 'node:fs';

import { foreignDatabaseEntries, linkedDatabasePath, type DatabaseDirectoryEntry } from '@vibe-agent-toolkit/rag-lancedb';
import { classifyFsFault, type FsFaultContext, type FsSide, isFileInTheWayError, isPathAbsentError, isVatError, mkdirSyncReal, RAG_INDEX_EMPTY_CODE, TREE_DEST_NOT_OWNED_CODE, VatError, withFsFaultSync } from '@vibe-agent-toolkit/utils';

import { CommandRefusalError } from './command-refusal.js';

/** How many foreign entries a refusal names before it summarises the rest. */
const NAMED_ENTRIES = 5;

/**
 * How a database path's filesystem fault is classified: on the verb's side (`source` for
 * the verbs that read it, `destination` for `index` and `clear`, which write and remove
 * it), named by `--db` (`argument`) or the project's own default (`content`).
 */
function databaseFault(dbPath: string, side: FsSide, explicit: boolean, action: string): FsFaultContext {
  return { side, origin: explicit ? 'argument' : 'content', action, path: dbPath };
}

/**
 * What a probe of the database path found: the answer, or one of the two shapes the
 * invocation is refused in its own words — nothing there, or a file in the way (the path
 * itself, or one above it). Any other fault the OS raises is thrown classified.
 */
type Probed<T> = { readonly found: T } | { readonly missing: 'absent' | 'file-in-the-way' };

function probe<T>(fault: FsFaultContext, read: () => T): Probed<T> {
  try {
    return { found: read() };
  } catch (error) {
    if (isFileInTheWayError(error)) return { missing: 'file-in-the-way' };
    if (isPathAbsentError(error)) return { missing: 'absent' };
    throw classifyFsFault(error, fault);
  }
}

/** Whether a probe met a file in the way. */
const fileInTheWay = <T>(probed: Probed<T>): boolean => 'missing' in probed && probed.missing === 'file-in-the-way';

/**
 * Why a path that would not list is not a directory: it is a file itself, or
 * something above it is (`readdir` says ENOTDIR for both).
 *
 * @param dbPath - The path `readdir` refused with ENOTDIR
 * @param fault - How a `stat` the OS refuses is classified
 * @returns The sentence naming which
 */
function notADirectory(dbPath: string, fault: FsFaultContext): string {
  return fileInTheWay(probe(fault, () => statSync(dbPath))) ? `a path above ${dbPath} is not a directory` : `${dbPath} is not a directory`;
}

/**
 * List the database directory, refusing a path that is not one.
 *
 * @param dbPath - The resolved database path
 * @param explicit - Whether `--db` named it
 * @param side - The verb's side of the database
 * @returns Its typed entries
 */
function listDatabase(dbPath: string, explicit: boolean, side: FsSide): DatabaseDirectoryEntry[] {
  const fault = databaseFault(dbPath, side, explicit, 'list the RAG database');
  const listed = probe<DatabaseDirectoryEntry[]>(fault, () => readdirSync(dbPath, { withFileTypes: true }));
  if ('found' in listed) return listed.found;
  if (fileInTheWay(listed)) {
    // A --db naming a file is the invocation's mistake; the project's own `.rag-db` being one is its state.
    throw new CommandRefusalError(explicit ? 'USAGE_INVALID' : 'INPUT_UNREADABLE', `Not a RAG database: ${notADirectory(dbPath, fault)}.`);
  }
  // A --db naming nothing is the invocation's mistake; the project's own default missing means nothing was indexed.
  throw explicit
    ? new CommandRefusalError('USAGE_INVALID', `Path does not exist: ${dbPath}`)
    : new VatError(RAG_INDEX_EMPTY_CODE, `No data indexed yet: there is no RAG database at ${dbPath}. Run vat rag index first.`);
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
 * @param side - The verb's side of the database: `source` for `stats` and `query`,
 *   which read it; `destination` for `clear`, which removes it
 * @throws {CommandRefusalError} `USAGE_INVALID` for a `--db` that names nothing
 *   or a file, and for a `--db` directory holding anything but a RAG database
 *   (operating-system litter such as `.DS_Store` aside); `INPUT_UNREADABLE` for
 *   a project `.rag-db` that is a file or holds anything else
 * @throws {FsFaultError} for a path the OS will not list, classified on `side`
 * @throws {VatError} `RAG_INDEX_EMPTY` (`INPUT_UNREADABLE`) when the project
 *   default is absent: nothing has been indexed, the same refusal a query over
 *   an empty index gets
 */
export function requireExistingDatabase(dbPath: string, explicit: boolean, side: FsSide): void {
  refuseForeignEntries(dbPath, listDatabase(dbPath, explicit, side), explicit, 'Nothing was read or removed', 'the directory vat rag index wrote');
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
  const foreign = foreignDatabaseEntries(dbPath, entries);
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
 * The refusal a database `vat rag clear` will not remove is — a link (removing it would leave
 * the database it names in place), or a directory holding anything a database does not, as
 * `removeRagDatabase`'s plan judged it (`TREE_DEST_NOT_OWNED`): the invocation's to fix for a
 * `--db`, the project's state for its own `.rag-db`, as {@link refuseForeignEntries} decides.
 *
 * A link's refusal ends with the command that clears the database it leads to.
 *
 * @param error - What the removal threw
 * @param dbPath - The database path the removal was given
 * @param explicit - Whether `--db` named the database; otherwise it is the project default
 * @returns The refusal for a not-owned database; any other error as it is
 */
export function notRemovableRefusal(error: unknown, dbPath: string, explicit: boolean): unknown {
  if (!isVatError(error, TREE_DEST_NOT_OWNED_CODE)) return error;
  const real = linkedDatabasePath(dbPath);
  const remedy = real === undefined ? '' : ` Run vat rag clear --db ${real} to clear the database itself.`;
  return new CommandRefusalError(explicit ? 'USAGE_INVALID' : 'INPUT_UNREADABLE', `Not removed: ${error.message}.${remedy}`, { cause: error });
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
 *   `INPUT_UNREADABLE` for a project `.rag-db` that is either
 * @throws {FsFaultError} a `destination` fault for a path the OS will not examine
 *   or list, and for a database directory the run cannot create or write
 *   (`RUN_INCOMPLETE`): the database is what `vat rag index` writes
 */
export function requireWritableDatabase(dbPath: string, explicit: boolean): void {
  const inputRefusal = explicit ? 'USAGE_INVALID' : 'INPUT_UNREADABLE';
  const fault = databaseFault(dbPath, 'destination', explicit, 'examine the RAG database directory');
  const stats = probe(fault, () => statSync(dbPath));
  if (fileInTheWay(stats)) {
    throw new CommandRefusalError(inputRefusal, `Cannot index into ${dbPath}: a path above it is not a directory.`);
  }
  if (!('found' in stats)) {
    withFsFaultSync({ ...fault, action: 'create the RAG database directory' }, () => mkdirSyncReal(dbPath, { recursive: true }));
    return;
  }
  if (!stats.found.isDirectory()) {
    throw new CommandRefusalError(inputRefusal, `Cannot index into ${dbPath}: it is not a directory, so it cannot hold a RAG database.`);
  }
  // LanceDB writes its tables into whatever directory it is handed: `--db .` filled the project root.
  refuseForeignEntries(dbPath, listDatabase(dbPath, explicit, 'destination'), explicit, 'Nothing was indexed', 'a RAG database, an empty directory or a path that does not exist yet');
  withFsFaultSync({ ...fault, action: 'write into the RAG database directory' }, () => accessSync(dbPath, constants.W_OK));
}
