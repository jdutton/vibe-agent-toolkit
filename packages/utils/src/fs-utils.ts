/**
 * Filesystem utilities
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { toForwardSlash } from './path-core.js';
import { safePath } from './path-utils.js';

/**
 * Per-run memo for the two filesystem lookups that validation repeats on values
 * which are constant for the whole run: `realpath` of roots, and `readdir` of the
 * directories link targets live in.
 *
 * A markdown corpus resolves thousands of links into a few hundred directories, so
 * the uncached form is an N+1: measured at 9,963 `readdir` calls on a 3,437-document
 * tree and 7,443 on a 1,132-document monorepo. Concurrent callers share the
 * in-flight promise rather than each starting their own syscall.
 *
 * **Instance-based on purpose — never make this a module-level singleton.** The
 * cache holds a *snapshot* of directory contents, and a long-lived process (watch
 * mode, a language server, a daemon) would then answer from a listing taken
 * arbitrarily long ago. The intended lifetime is one instance per validation run,
 * constructed as a local and collected with the run.
 *
 * @example
 * ```typescript
 * const fsCache = new FsLookupCache();          // one per run
 * for (const link of links) {
 *   await verifyCaseSensitiveFilename(link.target, fsCache);
 * }
 * ```
 */
export class FsLookupCache {
  /** Directory path → its entry names, or `null` when the directory is unreadable. */
  readonly #listings = new Map<string, Promise<string[] | null>>();

  /** Path → its canonical path, falling back to the resolved path. */
  readonly #realpaths = new Map<string, Promise<string>>();

  /**
   * Canonical path for `targetPath`, falling back to `safePath.resolve()` when the
   * path does not exist or cannot be resolved (a non-existent file has no realpath,
   * and callers comparing paths still need an answer).
   *
   * @param targetPath - Path to canonicalize
   * @returns Canonical path with forward slashes on every platform
   */
  realpath(targetPath: string): Promise<string> {
    const cached = this.#realpaths.get(targetPath);
    if (cached !== undefined) return cached;

    // Stored before the first `await` anywhere can run, so concurrent callers
    // reaching this method share the one in-flight promise.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- caller-validated path
    const pending = fs
      .realpath(targetPath)
      .then(toForwardSlash)
      .catch(() => safePath.resolve(targetPath));
    this.#realpaths.set(targetPath, pending);
    return pending;
  }

  /**
   * Entry names of `dirPath`, or `null` when it cannot be read (missing directory,
   * no permission). The unreadable answer is cached too — re-asking is the same
   * failed syscall.
   *
   * @param dirPath - Directory to list
   * @returns Entry names, or `null` if the directory could not be read
   */
  readdir(dirPath: string): Promise<string[] | null> {
    const cached = this.#listings.get(dirPath);
    if (cached !== undefined) return cached;

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- caller-validated path
    const pending = fs.readdir(dirPath).catch(() => null);
    this.#listings.set(dirPath, pending);
    return pending;
  }
}

/**
 * Recursively copy a directory
 *
 * @param src - Source directory path
 * @param dest - Destination directory path
 *
 * @example
 * await copyDirectory('/source/dir', '/dest/dir');
 */
export async function copyDirectory(src: string, dest: string): Promise<void> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Paths from validated sources
  await fs.mkdir(dest, { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Paths from validated sources
  const entries = await fs.readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = safePath.join(src, entry.name);
    const destPath = safePath.join(dest, entry.name);

    if (entry.isDirectory()) {
      await copyDirectory(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

/**
 * Verify that a file exists with the exact case-sensitive filename.
 *
 * On case-insensitive filesystems (Windows, macOS), a file might be found even if
 * the case doesn't match. This function checks that the actual filename on disk
 * matches the requested path exactly (case-sensitive).
 *
 * Answering requires listing the target's parent directory. Callers checking many
 * paths (every link in a corpus) hit the same handful of directories over and over,
 * so the listing comes from a caller-supplied {@link FsLookupCache}.
 *
 * The cache parameter is **required rather than defaulted on purpose**: a default
 * would let an unmigrated call site silently keep the un-memoized behaviour, which
 * is a no-op wearing the shape of a fix. `new FsLookupCache()` per call reproduces
 * the old behaviour exactly, so migrating is mechanical — but it has to be a
 * decision someone made.
 *
 * @param filePath - Absolute path to the file to verify
 * @param fsCache - Per-run lookup cache (one instance per validation run)
 * @returns Object with exists flag and actual filename (or null if not found)
 *
 * @example
 * ```typescript
 * // On case-insensitive filesystem with file "README.md"
 * const fsCache = new FsLookupCache();
 * const result1 = await verifyCaseSensitiveFilename('/project/README.md', fsCache);
 * // { exists: true, actualName: 'README.md' }
 *
 * const result2 = await verifyCaseSensitiveFilename('/project/readme.md', fsCache);
 * // { exists: false, actualName: 'README.md' } - case mismatch!
 * ```
 */
export async function verifyCaseSensitiveFilename(
  filePath: string,
  fsCache: FsLookupCache
): Promise<{ exists: boolean; actualName: string | null }> {
  // Get parent directory and expected filename
  const parentDir = path.dirname(filePath);
  const expectedName = path.basename(filePath);

  // Read actual directory entries
  const entries = await fsCache.readdir(parentDir);
  if (entries === null) {
    // Parent directory doesn't exist (or can't be read)
    return { exists: false, actualName: null };
  }

  // Find the actual filename (case-sensitive exact match)
  const exactMatch = entries.find(entry => entry === expectedName);

  if (exactMatch) {
    // Found exact case match - file exists with correct case
    return { exists: true, actualName: exactMatch };
  }

  // No exact match - check for case-insensitive match
  const caseInsensitiveMatch = entries.find(
    entry => entry.toLowerCase() === expectedName.toLowerCase()
  );

  // Return result:
  // - If case-insensitive match found: exists=false (wrong case), actualName=<actual>
  // - If no match at all: exists=false, actualName=null
  return {
    exists: false,
    actualName: caseInsensitiveMatch ?? null,
  };
}

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
  // Bounded: a malformed `cause` chain must not become an infinite loop here.
  for (let current: unknown = error, depth = 0; depth < 10; depth++) {
    if (typeof current !== 'object' || current === null) return false;
    if ('code' in current) {
      const { code } = current as { code: unknown };
      if (typeof code === 'string' && FILESYSTEM_ACCESS_ERRNOS.has(code)) return true;
    }
    if (!('cause' in current)) return false;
    current = (current as { cause: unknown }).cause;
  }
  return false;
}
