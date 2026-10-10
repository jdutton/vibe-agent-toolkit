/**
 * The decisions of the apply half of the tree-change primitive, and of its file helpers, that touch
 * no filesystem: each is handed what was read and answers what to do. `apply.ts` and `files.ts` are
 * the halves that make the calls — and hold nothing else to decide.
 */

import type { FsFaultFacts } from '../errors/errno-table.js';
import { FsFaultError, type FsSide } from '../errors/fs-fault.js';
import { VatError } from '../errors/vat-error.js';
import { relativeEscapesRoot, safePath } from '../path-core.js';

import type { EntryKind, PlannedChange } from './plan.js';

/** {@link tempDirRefusal}: a directory to dispose of that is not strictly under the temp directory — a defect in the caller. */
export const TEMP_DIR_OUTSIDE_TMPDIR_CODE = 'TEMP_DIR_OUTSIDE_TMPDIR';

/** A replaced entry, parked once the new one was live, that could not be removed. */
export const TREE_CLEANUP_INCOMPLETE_CODE = 'TREE_CLEANUP_INCOMPLETE';

/**
 * Whether a `write` fill's failure is the DESTINATION's: the errno names a path under the staged
 * tree — all the callback may write. Anything else, an input the callback read (a sibling of the
 * destination included), is not: it is rethrown as it was, for the verb's boundary to classify.
 *
 * @param facts - The errno and the paths the OS named
 * @param sideOf - The side a path is on, with the staged tree as the only `destination`
 */
export function fillFaultIsDestinations(facts: Pick<FsFaultFacts, 'path' | 'dest'>, sideOf: (path: string) => FsSide | undefined): boolean {
  return [facts.path, facts.dest].some((named) => named !== undefined && sideOf(named) === 'destination');
}

/** What is at a destination when the apply reaches it. */
interface DestinationNow {
  readonly kind: EntryKind;
  /** Whether it is a directory holding nothing; read only when the plan took an empty directory as free. */
  readonly emptyDirectory: boolean;
}

/**
 * Whether a destination is no longer what the plan decided on — staging (a whole copy, a whole
 * build) runs between the plan and the first rename, and anything can write there meanwhile:
 * - another KIND of entry than the plan saw (nothing where it parks; something where it creates);
 * - a directory a `must-be-free` change took because it was EMPTY, and now is not.
 *
 * @returns What changed, for the refusal's wording; `undefined` when it is as planned
 */
export function changedSincePlan(planned: PlannedChange, now: DestinationNow): string | undefined {
  if (now.kind !== planned.existing) {
    return `it was ${describeKind(planned.existing)} when the change was planned and is ${describeKind(now.kind)} now`;
  }
  const tookAsFree = planned.change.ownership.kind === 'must-be-free' && planned.existing === 'directory';
  return tookAsFree && !now.emptyDirectory ? 'it was an empty directory when the change was planned and holds entries now' : undefined;
}

const describeKind = (kind: EntryKind): string => (kind === 'absent' ? 'absent' : `a ${kind}`);

/**
 * The refusal of a destination that changed under the apply: the table's `occupied` destination
 * fault (something appeared while the command wrote), naming it and what changed. The entry is
 * left exactly as it was found.
 */
export function changedDestinationFault(planned: PlannedChange, what: string): FsFaultError {
  const { dest, label } = planned.change;
  return new FsFaultError({
    side: 'destination',
    faultClass: 'occupied',
    errno: 'EEXIST',
    path: dest,
    origin: 'argument',
    action: `put ${label} in place: something else changed the destination while it was being prepared (${what}); it was left as found`,
    cause: undefined,
  });
}

/**
 * What a finalize does with the parked entries it could not remove: a REMOVE's is thrown (removal
 * was the job; the first one, with every other recorded beside it), a replace's is a warning — the
 * new tree is live.
 *
 * @param refused - Each parked entry that would not go, with the op of its change
 * @returns The index of the one to throw, or `undefined` when every one is a warning
 */
export function finalizeThrows(refused: ReadonlyArray<{ readonly op: PlannedChange['change']['op'] }>): number | undefined {
  const index = refused.findIndex((each) => each.op === 'remove');
  return index === -1 ? undefined : index;
}

/**
 * Where the removal of the parents a create made goes next: `dir` is removed only while it is
 * `top` (the first directory `mkdir` made) or under it, and the walk stops once `top` itself went.
 *
 * @param top - The first directory staging made, canonical
 * @param dir - The directory about to be removed, canonical
 * @returns `stop` (outside what staging made: never touched), `last` (it is `top`), or `continue` (go on to its parent)
 */
export function madeParentStep(top: string, dir: string): 'stop' | 'last' | 'continue' {
  const below = safePath.relative(top, dir);
  if (relativeEscapesRoot(below)) return 'stop';
  return below === '' ? 'last' : 'continue';
}

/**
 * The refusal of a file VAT writes into a tree it is building, where what was copied into that tree
 * already holds an entry on the way — a file or a link at the file's own name, or a link (or a file)
 * where one of its directories goes. Whatever is there came with the tree, so it is the SOURCE's
 * layout (origin `content`), never something to write over or through.
 *
 * @param entry - The entry in the way, as a path
 * @param writing - What VAT was writing, for the message: `VAT's marketplace marker`
 * @param cause - The errno that reported it, when one did
 */
export function entryInTheWayFault(entry: string, writing: string, cause: unknown): FsFaultError {
  return new FsFaultError({
    side: 'source',
    faultClass: 'occupied',
    errno: 'EEXIST',
    path: entry,
    origin: 'content',
    action: `write ${writing}: the tree it goes into already holds an entry there, which VAT never writes over or through`,
    cause,
  });
}

const WIN32_NAMESPACE = String.raw`\\?` + '\\';
const WIN32_UNC_NAMESPACE = `${WIN32_NAMESPACE}UNC\\`;

/**
 * The first directory a recursive `mkdir` reports it made, in the spelling the caller's own paths
 * have. Under win32 Node hands the OS a namespaced path (`\\?\C:\…`, `\\?\UNC\server\share\…`) and
 * may report the directory it made in that form; held against a plain `C:\…` destination it reads as
 * another root, and the parents a failed create made would then never be removed
 * ({@link madeParentStep} stops at the first step). Everything else is returned as it is.
 */
export function madeDirectoryPath(made: string): string {
  if (made.startsWith(WIN32_UNC_NAMESPACE)) return `\\\\${made.slice(WIN32_UNC_NAMESPACE.length)}`;
  return made.startsWith(WIN32_NAMESPACE) ? made.slice(WIN32_NAMESPACE.length) : made;
}

/** A rename is tried this many times under win32 when the OS reports contention; the waits between are 50, 100, 200, 400, 800 ms. */
export const RENAME_TRIES = 6;
const FIRST_BACKOFF_MS = 50;

/**
 * Whether a refused rename is tried again, and after how long: only under win32, only for
 * contention (a scanner, an indexer, a handle still closing), and only while tries are left.
 *
 * @param platform - `process.platform`
 * @param attempt - The 0-based try that just failed
 * @param contention - Whether the errno is one a rename race raises there
 * @returns The wait in milliseconds before the next try, or `undefined` when the refusal is final
 */
export function renameRetryDelay(platform: NodeJS.Platform, attempt: number, contention: boolean): number | undefined {
  if (platform !== 'win32' || !contention || attempt + 1 >= RENAME_TRIES) return undefined;
  return FIRST_BACKOFF_MS * 2 ** attempt;
}

/**
 * The refusal — a defect in the caller — of a directory to dispose of that is not strictly under
 * the temp directory: the disposal makes a read-only tree writable before it deletes it, so a wrong
 * argument (an empty string, a project directory) must be refused before anything is touched.
 *
 * @param dir - The directory handed to the disposal
 * @param tmp - The temp directory
 * @param containment - Where `dir` is against `tmp`, as `isUnderRoot` judged it
 * @returns The error to throw, or `undefined` when `dir` may be disposed of
 */
export function tempDirRefusal(dir: string, tmp: string, containment: 'inside' | 'outside' | 'absent'): VatError | undefined {
  if (containment !== 'outside') return undefined;
  return new VatError(TEMP_DIR_OUTSIDE_TMPDIR_CODE, `Refusing to dispose of ${dir}: it is not inside the temporary directory ${tmp}`);
}
