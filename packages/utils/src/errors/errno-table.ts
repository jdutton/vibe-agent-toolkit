/**
 * The errno table and every single-errno question — the leaf of the fs-fault
 * family.
 *
 * ⚠️ This module imports nothing but `win32-namespace.ts`, a leaf that itself imports nothing. `path-containment.ts`, `path-utils.ts`,
 * `dirent-kind.ts` and `fs-utils.ts` ask "is there nothing at this path?", and
 * `fs-fault.ts` needs `path-containment.ts` to decide a side by containment, so
 * the table cannot live in `fs-fault.ts` without an import cycle
 * (`fs-fault → path-containment → fs-fault`). It lives here, and `fs-fault.ts`
 * builds classification on top of it.
 *
 * The errno sets are those of the former `FILESYSTEM_ACCESS_ERRNOS`; every
 * member keeps exactly one class. The table is not the guarantee: an errno it
 * does not list, on an error a system call raised, is still a fault — of the
 * `device` class ({@link UNLISTED_ERRNO_CLASS}) — so a code libuv adds, or one a
 * host reports that nobody wrote down, is never handed back raw. An error with
 * no errno-shaped `code` is not a filesystem fault and {@link fsFaultOf} answers
 * `undefined`, so a `TypeError` from a validator is never read as the
 * environment's fault. The errnos a socket shares with a file on a share — the
 * network ones — and every unlisted errno count only when a filesystem call
 * raised them ({@link isRaisedByFilesystemCall}), so a `connect` or a fetch that
 * failed is never read as one either.
 */

import { withoutWin32Namespace } from '../win32-namespace.js';

/** What kind of thing the OS said went wrong, independent of which side of a verb it happened on. */
export type FsFaultClass = 'absent' | 'refused' | 'exhausted' | 'wrong-type' | 'occupied' | 'busy' | 'unsupported' | 'device';

/**
 * The one place an errno gets a class. `EROFS` is `unsupported`: the filesystem cannot be written, no permission would change it.
 *
 * Frozen, lists included: the classifier's lookup is built from it once, at load, so a list a
 * consumer could change afterwards would be a second table the classifier does not agree with.
 */
export const FS_FAULT_ERRNOS_BY_CLASS: Readonly<Record<FsFaultClass, readonly string[]>> = {
  absent: ['ENOENT', 'ENOTDIR'],
  refused: ['EACCES', 'EPERM'],
  exhausted: ['ENOSPC', 'EDQUOT', 'EMFILE', 'ENFILE'],
  // EFTYPE: BSD's errno for a named pipe, socket or device where content was expected (`readDecodableBytes` raises it)
  'wrong-type': ['EISDIR', 'EFTYPE', 'ELOOP', 'ENAMETOOLONG'],
  occupied: ['EEXIST', 'ENOTEMPTY'],
  busy: ['EBUSY', 'ETXTBSY', 'EAGAIN'],
  unsupported: ['ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EINVAL', 'EROFS'],
  // The network errnos a file call on a share raises — libuv v1.x `src/win/error.c` maps
  // `ERROR_NETWORK_UNREACHABLE` to ENETUNREACH (:131), `ERROR_HOST_UNREACHABLE` to EHOSTUNREACH
  // (:100), `ERROR_NETNAME_DELETED` (the share went away mid-call) to ECONNRESET (:94) and
  // `ERROR_NOT_CONNECTED` to ENOTCONN (:152).
  //
  // UNKNOWN: what `uv_translate_sys_error` answers for a Win32 error it has NO case for (`default:
  // return UV_UNKNOWN;`, :172) — and only that; every Win32 error with a case is its mapped errno,
  // the network ones above included. Among the unmapped: a share that is not there
  // (`ERROR_BAD_NETPATH`, `ERROR_BAD_NET_NAME`), credentials or an ACL the share refused
  // (`ERROR_LOGON_FAILURE`, `ERROR_NETWORK_ACCESS_DENIED`), a drive that is not ready or not there
  // (`ERROR_NOT_READY`, `ERROR_DEV_NOT_EXIST`). The Win32 cause is lost, so UNKNOWN is ambiguous: a
  // fault, never "resolves to nothing".
  device: ['EIO', 'ESTALE', 'ETIMEDOUT', 'EHOSTDOWN', 'ENETDOWN', 'ENETUNREACH', 'EHOSTUNREACH', 'ECONNRESET', 'ENOTCONN', 'UNKNOWN'],
};
for (const errnos of Object.values(FS_FAULT_ERRNOS_BY_CLASS)) Object.freeze(errnos);
Object.freeze(FS_FAULT_ERRNOS_BY_CLASS);

const CLASS_BY_ERRNO: ReadonlyMap<string, FsFaultClass> = new Map(
  (Object.entries(FS_FAULT_ERRNOS_BY_CLASS) as Array<[FsFaultClass, readonly string[]]>)
    .flatMap(([faultClass, errnos]) => errnos.map((errno): [string, FsFaultClass] => [errno, faultClass])),
);

/**
 * The class of an errno the table does not list, raised by a system call (`EFAULT`, `ECHARSET`,
 * whatever a later libuv or another host adds). `device`: the OS could not complete the call for a
 * reason VAT has no name for — a fault on the side it happened, with the "check the device" remedy,
 * never "nothing there" and never an internal error.
 */
const UNLISTED_ERRNO_CLASS: FsFaultClass = 'device';

/** An errno-shaped code: libuv's `E…` names and its `UNKNOWN`. Node's own `ERR_…` codes are not errnos. */
const ERRNO_SHAPE = /^(E[A-Z0-9]+|UNKNOWN)$/;

/**
 * The listed errnos a socket raises as readily as a file call on a share does. Listed (a share
 * reports them), but a fault only when a filesystem call raised them ({@link isRaisedByFilesystemCall}).
 */
const NETWORK_ERRNOS: ReadonlySet<string> = new Set(['ENETUNREACH', 'EHOSTUNREACH', 'ECONNRESET', 'ENOTCONN']);

/**
 * The filesystem calls that act on a descriptor and so name no path. `read`, `write` and `close`
 * are not here: a socket raises them too (a fetch's `ECONNRESET` is `syscall: 'read'`), and nothing
 * on the error tells the two apart.
 */
const FILESYSTEM_FD_SYSCALLS: ReadonlySet<string> = new Set(['fstat', 'ftruncate', 'fsync', 'fdatasync', 'futime', 'fchmod', 'fchown']);

/**
 * The ONE test of "a filesystem call raised this": the error names the path it acted on (`path`
 * or `dest` — every path-taking fs call reports one, and no socket call does: a socket names an
 * `address`), or its syscall is a descriptor-only filesystem call ({@link FILESYSTEM_FD_SYSCALLS}).
 * Both the network errnos and the unlisted fallback ask it, so they cannot disagree.
 */
function isRaisedByFilesystemCall(node: object): boolean {
  if (stringField(node, 'path') !== undefined || stringField(node, 'dest') !== undefined) return true;
  const syscall = stringField(node, 'syscall');
  return syscall !== undefined && FILESYSTEM_FD_SYSCALLS.has(syscall);
}

/** Whether the error that carries `code` holds a listed errno that is a fault here. */
function isListedFault(code: string, node: object): boolean {
  return CLASS_BY_ERRNO.has(code) && (!NETWORK_ERRNOS.has(code) || isRaisedByFilesystemCall(node));
}

/** Whether the error that carries `code` is a filesystem call's errno the table does not list. */
function isUnlistedFilesystemErrno(code: string, node: object): boolean {
  return ERRNO_SHAPE.test(code) && !CLASS_BY_ERRNO.has(code) && isRaisedByFilesystemCall(node);
}

/**
 * The class of an errno a caller already KNOWS a filesystem call raised — a listing git reported
 * it could not open, say, where only the errno survives: the table's class, else
 * {@link UNLISTED_ERRNO_CLASS}. Never `undefined`: the question "is this the filesystem?" was
 * settled where the error was in hand.
 *
 * @param errno - The errno
 * @returns Its class
 */
export function filesystemErrnoClass(errno: string): FsFaultClass {
  if (errno === LINK_CHAIN_REFUSED_CODE) return 'refused';
  return CLASS_BY_ERRNO.get(errno) ?? UNLISTED_ERRNO_CLASS;
}

/**
 * The code a path whose link chain VAT will not hand the kernel is refused with
 * (`LinkChainRefusedError`, `tree-change/host-chain.ts`): a link on the way names
 * a network path, or the chain never ends. Not an errno — VAT declined to ask the
 * OS — but recorded where an errno is (a refused listing, a fault row), always
 * of the `refused` class.
 */
export const LINK_CHAIN_REFUSED_CODE = 'LINK_CHAIN_REFUSED';

/** What `fsFaultOf` learned from the error that carried the errno. */
export interface FsFaultFacts {
  readonly errno: string;
  readonly faultClass: FsFaultClass;
  readonly path: string | undefined;
  readonly dest: string | undefined;
  readonly syscall: string | undefined;
}

const MAX_CAUSE_DEPTH = 10;

/** A path field of an errno, without the win32 namespace prefix Node may report it with — read once, here, for every consumer. */
function reportedPath(source: object, key: 'path' | 'dest'): string | undefined {
  const reported = stringField(source, key);
  return reported === undefined ? undefined : withoutWin32Namespace(reported);
}

function stringField(source: object, key: string): string | undefined {
  const value = (source as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * The first error on `error`'s `cause` chain whose string `code` satisfies
 * `accept`. Bounded: a malformed chain must not become an infinite loop inside
 * an error path, which is the worst place to hang.
 */
function findCoded(error: unknown, accept: (code: string, node: object) => boolean): { node: object; code: string } | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    if (typeof current !== 'object' || current === null) return undefined;
    const code = stringField(current, 'code');
    if (code !== undefined && accept(code, current)) return { node: current, code };
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
 *
 * A listed errno anywhere on the chain wins (a network one only from a filesystem call); failing
 * that, the first errno a filesystem call raised that the table does not list is a fault of
 * {@link UNLISTED_ERRNO_CLASS} — never `undefined`, so no caller hands it back raw.
 */
export function fsFaultOf(error: unknown): FsFaultFacts | undefined {
  const found = findCoded(error, isListedFault) ?? findCoded(error, isUnlistedFilesystemErrno);
  if (found === undefined) return undefined;
  return {
    errno: found.code,
    faultClass: filesystemErrnoClass(found.code),
    path: reportedPath(found.node, 'path'),
    dest: reportedPath(found.node, 'dest'),
    syscall: stringField(found.node, 'syscall'),
  };
}

/**
 * The paths the failing syscall ACTED ON, the one to name the fault by first.
 *
 * Node files a two-path call's first argument under `path` and its second under `dest`, whatever
 * the call does with them. For `symlink(target, link)` the first is the link's TARGET TEXT — a
 * string the call never resolved, often relative — so only `dest`, the link being created, is a
 * path the call acted on. `rename(from, to)` acted on both, and what it could not do is land the
 * entry: `dest` first. Every other call — `link(existing, new)` and `copyfile` included, whose
 * two arguments are both real paths either of which may be the one refused — is read `path` first.
 *
 * @param facts - The fault's facts, as {@link fsFaultOf} read them off the errno
 * @returns Every path the call acted on, the one that names the fault first; empty when the errno carries none
 */
export function pathsActedOn(facts: FsFaultFacts): readonly string[] {
  const { path, dest, syscall } = facts;
  let ordered: ReadonlyArray<string | undefined> = [path, dest];
  if (syscall === 'symlink') ordered = [dest];
  else if (syscall === 'rename') ordered = [dest, path];
  return ordered.filter((each): each is string => each !== undefined);
}

/**
 * For a refused `rename`, the entry that was being moved — the other end of the path the fault is
 * named by. `undefined` for every other call, and for a rename whose errno names one path only.
 *
 * @param facts - The fault's facts, as {@link fsFaultOf} read them off the errno
 */
export function movedFromOf(facts: FsFaultFacts): string | undefined {
  return facts.syscall === 'rename' && facts.dest !== undefined ? facts.path : undefined;
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

/**
 * The errnos with which the OS LOOKED and found nothing a link resolves to: the `absent` class
 * (`ENOENT`, `ENOTDIR` — it dangles) and `ELOOP` (a cycle; on Windows
 * `ERROR_CANT_RESOLVE_FILENAME`). On Windows a dangling link or junction is `ENOENT`. Every other
 * errno says nothing about the link — the OS declining (`EACCES`, `EPERM`), running short
 * (`EMFILE`, `ENOSPC`), being held (`EBUSY`), failing to look (`EIO`, `ESTALE`, `ETIMEDOUT`, the
 * network errnos) — and so does an AMBIGUOUS one: libuv v1.x `src/win/error.c` reports
 * `ERROR_INVALID_PARAMETER`, `ERROR_INVALID_DATA`, `ERROR_INSUFFICIENT_BUFFER` and
 * `ERROR_SYMLINK_NOT_SUPPORTED` all as `EINVAL` (:102-105), `ERROR_BUFFER_OVERFLOW` as
 * `ENAMETOOLONG` (:129), and every Win32 error it has no case for as `UNKNOWN` (:172) — a missing
 * share AND refused credentials. A cause that cannot be told apart is a fault, never "nothing there".
 */
const UNRESOLVABLE_LINK_ERRNOS: readonly string[] = Object.freeze([...FS_FAULT_ERRNOS_BY_CLASS.absent, 'ELOOP']);

/**
 * Whether resolving a link failed because **the link resolves to nothing** ({@link UNRESOLVABLE_LINK_ERRNOS}),
 * as opposed to a fault of the OS or the operator's tree, which the caller throws for the classifier.
 * The one answer to "does this link resolve?" for every site that follows one. `false` for an
 * error that carries no errno.
 */
export function isUnresolvableLinkError(error: unknown): boolean {
  return hasAnyErrno(error, UNRESOLVABLE_LINK_ERRNOS);
}

/**
 * `EISDIR`, `ENOTSUP`, `EOPNOTSUPP` from a NATIVE realpath (`realpathSync.native`, `fs/promises.realpath`):
 * the volume cannot answer a final-path query, which says nothing about the path. On Windows libuv
 * maps `ERROR_INVALID_FUNCTION` — what `GetFinalPathNameByHandleW` returns on a RAM disk or a
 * redirector that does not implement it — to `EISDIR` (`src/win/error.c`). The answer is the JS
 * realpath (an lstat/readlink walk), which never asks that question.
 */
export function isFinalPathUnanswerableError(error: unknown): boolean {
  return hasAnyErrno(error, ['EISDIR', 'ENOTSUP', 'EOPNOTSUPP']);
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
