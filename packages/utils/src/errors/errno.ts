/**
 * Errno predicates — the two questions every catch site asks of an OS error,
 * answered by the `code` on the error or down its `cause` chain.
 *
 * ⚠️ This module imports NOTHING. It is the leaf that `fs-utils.ts`,
 * `path-utils.ts`, `dirent-kind.ts`, `path-containment.ts` and the rest of the
 * package share; it lived in `fs-utils.ts` until that put three of them in an
 * import cycle (`fs-utils → path-utils → fs-utils` and two more), and a leaf
 * is the one place a shared predicate cannot re-open one. (The cycle was once
 * blamed for a platform-dependent knip verdict on these two names; breaking it
 * changed nothing there — the cause was a missing knip entry, see
 * `docs/contributing/traps.md`, "A subpath module's re-exports flap by platform".)
 */

/**
 * Errno codes meaning "the filesystem refused this path", as opposed to a defect
 * in our own code.
 *
 * Shared because two lanes need the same answer and must not drift: `vat audit`
 * decides whether to degrade a scan over a tree it does not own, and the skill
 * packager decides whether a `files:` match is copyable. A second, independently
 * written list is how those two come to disagree about what counts as the
 * environment's fault.
 *
 * The set is deliberately broad. An earlier, "conservative" version omitted
 * `ENOTSUP` — the errno of the very issue this was written for — along with
 * `EEXIST`, which an ordinary two-entry `files:` config reaches with no
 * permissions involved at all. Both escaped raw. Every code here means the OS
 * refused a syscall on a path; none of them can be produced by a type error or a
 * logic bug in our own code, which is the only distinction the callers need.
 *
 * `EIO` and `EBUSY` are included even though they can indicate failing hardware:
 * neither caller *swallows* anything, each reports the path and the OS message,
 * so a dying disk surfaces once per affected path. Aborting the run instead would
 * report less. `ENOENT` is included because a bulk scan races real filesystems —
 * an entry listed by `readdir` can be gone by the time it is opened.
 */
const FILESYSTEM_ACCESS_ERRNOS: ReadonlySet<string> = new Set([
  // Permission and ownership
  'EACCES', 'EPERM', 'EROFS',
  // Presence and shape
  'ENOENT', 'EEXIST', 'ENOTDIR', 'EISDIR', 'ENOTEMPTY', 'ELOOP', 'ENAMETOOLONG',
  // Capability of the object or filesystem
  'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ETXTBSY', 'EINVAL',
  // Resource exhaustion and transient device state
  'ENOSPC', 'EDQUOT', 'EMFILE', 'ENFILE', 'EIO', 'EBUSY', 'EAGAIN',
  // Network filesystems
  'ESTALE', 'ETIMEDOUT', 'EHOSTDOWN', 'ENETDOWN',
  // Windows surfaces this for reparse points and some network paths
  'UNKNOWN',
]);

/**
 * Whether `error` is the filesystem refusing a path rather than a bug.
 *
 * Deliberately NOT `error instanceof Error`: the point of every caller is to
 * degrade on a hostile tree, and a `TypeError` from a validator is not that.
 * Treating one as environmental turns a real defect into a warning about
 * whichever file it happened on — which makes a tool quietest exactly when it is
 * most wrong.
 *
 * Walks `cause`, because the errno is routinely re-wrapped on its way up. The CLI
 * config loader turns a read failure into `new Error('Failed to load config: …')`;
 * without following the chain the predicate answered "not a filesystem error" for
 * a plain `EACCES`, and an unreadable config aborted a whole `vat audit` run. Any
 * layer that adds context to an OS error defeats a `code`-only check, so the check
 * cannot be `code`-only.
 */
export function isFilesystemAccessError(error: unknown): boolean {
  return hasErrnoCode(error, (code) => FILESYSTEM_ACCESS_ERRNOS.has(code));
}

/**
 * Whether `error` means **there is nothing at this path** — `ENOENT`, or
 * `ENOTDIR` for a path whose component turned out to be a file — and nothing
 * else.
 *
 * This is the narrowing a `try { stat(p) } catch { return null }` is rewritten
 * to under the `no-blind-catch` lint rule: the sentinel stands for *absent*,
 * so only an absence may produce it; a refusal (`EACCES`, `EPERM`, `ELOOP`) or
 * a bug (`TypeError`) is rethrown and stays loud.
 *
 * ⚠️ Deliberately NOT {@link isFilesystemAccessError}. That predicate answers
 * "is this the environment's fault?" and to answer it groups `ENOENT` with
 * `EACCES` — the exact conflation that once turned an unreadable directory
 * into an empty one. The two questions have two predicates on purpose; see
 * also {@link listingFailure}, which makes the same split for `readdir`.
 *
 * Walks `cause` for the same reason its sibling does: the errno is routinely
 * re-wrapped on its way up.
 */
export function isPathAbsentError(error: unknown): boolean {
  return hasErrnoCode(error, (code) => code === 'ENOENT' || code === 'ENOTDIR');
}

/**
 * Whether any string `code` on `error` or down its `cause` chain satisfies
 * `accept`. Bounded: a malformed `cause` chain must not become an infinite
 * loop inside an error path, which is the worst place to hang.
 */
function hasErrnoCode(error: unknown, accept: (code: string) => boolean): boolean {
  for (let current: unknown = error, depth = 0; depth < 10; depth++) {
    if (typeof current !== 'object' || current === null) return false;
    if ('code' in current) {
      const { code } = current as { code: unknown };
      if (typeof code === 'string' && accept(code)) return true;
    }
    if (!('cause' in current)) return false;
    current = (current as { cause: unknown }).cause;
  }
  return false;
}
