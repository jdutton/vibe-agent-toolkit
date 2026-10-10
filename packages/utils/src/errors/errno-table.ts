/**
 * The errno table and every single-errno question — the leaf of the fs-fault
 * family.
 *
 * ⚠️ This module imports NOTHING. `path-containment.ts`, `path-utils.ts`,
 * `dirent-kind.ts` and `fs-utils.ts` ask "is there nothing at this path?", and
 * `fs-fault.ts` needs `path-containment.ts` to decide a side by containment, so
 * the table cannot live in `fs-fault.ts` without an import cycle
 * (`fs-fault → path-containment → fs-fault`). It lives here, and `fs-fault.ts`
 * builds classification on top of it.
 *
 * The errno sets are those of the former `FILESYSTEM_ACCESS_ERRNOS`; every
 * member keeps exactly one class. An errno outside the table is not a
 * filesystem fault and {@link fsFaultOf} answers `undefined`, so a `TypeError`
 * from a validator is never read as the environment's fault.
 */

/** What kind of thing the OS said went wrong, independent of which side of a verb it happened on. */
export type FsFaultClass = 'absent' | 'refused' | 'exhausted' | 'wrong-type' | 'occupied' | 'busy' | 'unsupported' | 'device';

/** The one place an errno gets a class. `EROFS` is `unsupported`: the filesystem cannot be written, no permission would change it. */
export const FS_FAULT_ERRNOS_BY_CLASS: Readonly<Record<FsFaultClass, readonly string[]>> = {
  absent: ['ENOENT', 'ENOTDIR'],
  refused: ['EACCES', 'EPERM'],
  exhausted: ['ENOSPC', 'EDQUOT', 'EMFILE', 'ENFILE'],
  // EFTYPE: BSD's errno for a named pipe, socket or device where content was expected (`readDecodableBytes` raises it)
  'wrong-type': ['EISDIR', 'EFTYPE', 'ELOOP', 'ENAMETOOLONG'],
  occupied: ['EEXIST', 'ENOTEMPTY'],
  busy: ['EBUSY', 'ETXTBSY', 'EAGAIN'],
  unsupported: ['ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EINVAL', 'EROFS'],
  // UNKNOWN: Windows surfaces it for reparse points and some network paths
  device: ['EIO', 'ESTALE', 'ETIMEDOUT', 'EHOSTDOWN', 'ENETDOWN', 'UNKNOWN'],
};

const CLASS_BY_ERRNO: ReadonlyMap<string, FsFaultClass> = new Map(
  (Object.entries(FS_FAULT_ERRNOS_BY_CLASS) as Array<[FsFaultClass, readonly string[]]>)
    .flatMap(([faultClass, errnos]) => errnos.map((errno): [string, FsFaultClass] => [errno, faultClass])),
);

/** What `fsFaultOf` learned from the error that carried the errno. */
export interface FsFaultFacts {
  readonly errno: string;
  readonly faultClass: FsFaultClass;
  readonly path: string | undefined;
  readonly dest: string | undefined;
  readonly syscall: string | undefined;
}

const MAX_CAUSE_DEPTH = 10;

function stringField(source: object, key: string): string | undefined {
  const value = (source as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * The first error on `error`'s `cause` chain whose string `code` satisfies
 * `accept`. Bounded: a malformed chain must not become an infinite loop inside
 * an error path, which is the worst place to hang.
 */
function findCoded(error: unknown, accept: (code: string) => boolean): { node: object; code: string } | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    if (typeof current !== 'object' || current === null) return undefined;
    const code = stringField(current, 'code');
    if (code !== undefined && accept(code)) return { node: current, code };
    if (!('cause' in current)) return undefined;
    current = (current as { cause: unknown }).cause;
  }
  return undefined;
}

/**
 * The classified errno on `error` or down its `cause` chain, with the path the OS
 * named — or `undefined` when this is not the filesystem refusing something.
 *
 * Deliberately NOT `error instanceof Error`: callers degrade on a hostile tree,
 * and a `TypeError` is not that. Walks `cause` because the errno is routinely
 * re-wrapped on its way up (the CLI config loader turns a read failure into
 * `new Error('Failed to load config: …')`); a `code`-only check answered "not a
 * filesystem error" for a plain `EACCES`.
 */
export function fsFaultOf(error: unknown): FsFaultFacts | undefined {
  const found = findCoded(error, (code) => CLASS_BY_ERRNO.has(code));
  if (found === undefined) return undefined;
  const faultClass = CLASS_BY_ERRNO.get(found.code);
  if (faultClass === undefined) return undefined;
  return {
    errno: found.code,
    faultClass,
    path: stringField(found.node, 'path'),
    dest: stringField(found.node, 'dest'),
    syscall: stringField(found.node, 'syscall'),
  };
}

function hasAnyErrno(error: unknown, errnos: readonly string[]): boolean {
  return findCoded(error, (code) => errnos.includes(code)) !== undefined;
}

/**
 * Whether `error` means **there is nothing at this path** — `ENOENT`, or `ENOTDIR`
 * for a path whose component turned out to be a file — and nothing else. The
 * narrowing a `try { stat(p) } catch { return null }` is rewritten to under
 * `no-blind-catch`: only an absence may produce the sentinel; a refusal or a
 * bug is rethrown.
 */
export function isPathAbsentError(error: unknown): boolean {
  return hasAnyErrno(error, FS_FAULT_ERRNOS_BY_CLASS.absent);
}

/**
 * `ENOENT` alone: nothing at this path, with every directory above it real. For a
 * site where `ENOTDIR` — a component that is a FILE — must stay loud, because it
 * means a misconfiguration rather than "not there yet" ({@link isPathAbsentError}
 * folds the two together).
 */
export function isNoSuchEntryError(error: unknown): boolean {
  return hasAnyErrno(error, ['ENOENT']);
}

/**
 * `ENOTDIR` alone: a component of the path is a FILE. On a write whose layout an
 * input decided, that is a file in the way of a directory the layout needs — a
 * layout fault, though the class table files `ENOTDIR` under `absent` (for a read
 * it means "nothing there").
 */
export function isFileInTheWayError(error: unknown): boolean {
  return hasAnyErrno(error, ['ENOTDIR']);
}

/** `EEXIST`: the exclusive create lost to something already there. */
export function isAlreadyExistsError(error: unknown): boolean {
  return hasAnyErrno(error, ['EEXIST']);
}

/** The `occupied` class (`EEXIST`, `ENOTEMPTY`): something is in the way — a directory `rmdir` was asked to remove still holds entries. */
export function isOccupiedError(error: unknown): boolean {
  return hasAnyErrno(error, FS_FAULT_ERRNOS_BY_CLASS.occupied);
}

/** `ELOOP`: a symlink chain that never ends. */
export function isLinkLoopError(error: unknown): boolean {
  return hasAnyErrno(error, ['ELOOP']);
}

/** `ENAMETOOLONG`: a name (or path) longer than this host's filesystem will take. */
export function isNameTooLongError(error: unknown): boolean {
  return hasAnyErrno(error, ['ENAMETOOLONG']);
}

/** `EINVAL`: the filesystem rejected the argument (e.g. `readlink` on a non-link). */
export function isInvalidArgumentError(error: unknown): boolean {
  return hasAnyErrno(error, ['EINVAL']);
}

/** `EFTYPE`: BSD's "inappropriate file type" — a pipe, socket or device where content was expected. */
export function isNotARegularFileError(error: unknown): boolean {
  return hasAnyErrno(error, ['EFTYPE']);
}

/** `ETIMEDOUT`: an operation (a child process given a `timeout`, a network filesystem) ran out of time. */
export function isTimedOutError(error: unknown): boolean {
  return hasAnyErrno(error, ['ETIMEDOUT']);
}

/** `EAGAIN`: a non-blocking descriptor (stdout on a full pipe) would block. */
export function isWouldBlockError(error: unknown): boolean {
  return hasAnyErrno(error, ['EAGAIN']);
}

/**
 * `ESRCH` or `EPERM` from signalling a process group we created: no such group,
 * or its id was recycled to a process we may not signal. Either way every
 * process of ours in it has exited — the outcome the kill was after.
 */
export function isProcessGoneError(error: unknown): boolean {
  return hasAnyErrno(error, ['ESRCH', 'EPERM']);
}

/** This host cannot create symlinks: Windows without Developer Mode (`EPERM`), or a filesystem with none (`ENOTSUP`/`EOPNOTSUPP`). */
export function isSymlinkUnsupportedError(error: unknown): boolean {
  return hasAnyErrno(error, ['EPERM', 'ENOTSUP', 'EOPNOTSUPP']);
}

/**
 * A refusal a re-ask can legitimately answer differently: the `busy` class
 * (`EBUSY`, `ETXTBSY`, `EAGAIN`), or this process out of descriptors (`EMFILE`,
 * `ENFILE`). Disk and quota exhaustion (`ENOSPC`, `EDQUOT`) share the `exhausted`
 * class but are NOT retryable: re-asking frees no space, so "re-run first" would
 * be the wrong advice.
 */
export function isRetryableShortageError(error: unknown): boolean {
  return hasAnyErrno(error, [...FS_FAULT_ERRNOS_BY_CLASS.busy, 'EMFILE', 'ENFILE']);
}

/**
 * The errnos Windows raises when a rename races a scanner, indexer or handle
 * that has the tree open: `EPERM`, `EBUSY`, `EACCES`. Worth a bounded retry;
 * anything else is final.
 */
export function isRenameContentionError(error: unknown): boolean {
  return hasAnyErrno(error, ['EPERM', 'EBUSY', 'EACCES']);
}

/**
 * The `refused` class (`EACCES`, `EPERM`): the OS refused the caller's access. A
 * removal refused this way is retried once its directories are made owner-writable:
 * a read-only directory refuses the removal of its entries.
 */
export function isAccessRefusedError(error: unknown): boolean {
  return hasAnyErrno(error, FS_FAULT_ERRNOS_BY_CLASS.refused);
}
