/**
 * Pure path-string helpers.
 *
 * **This module's only import is `node:path`.** Nothing here touches the
 * filesystem, the OS, or URLs — that is the whole point: the `./path` and
 * `./glob` subpath entries re-export from here so importing them can never
 * pull `node:fs`, `node:os`, or `node:url` into a consumer's graph.
 *
 * Filesystem-touching path helpers (`normalizePath`, `normalizedTmpdir`,
 * `mkdirSyncReal`, `resolveFromImportMeta`, `dynamicImportPath`) live in
 * `./path-utils.ts` and are exposed via the `./fs` entry.
 */

import path from 'node:path';

/**
 * Check if a path is absolute
 *
 * Cross-platform detection of absolute paths:
 * - Unix: /path/to/file
 * - Windows: C:\path\to\file or C:/path/to/file
 *
 * @param p - Path to check
 * @returns True if path is absolute
 *
 * @example
 * isAbsolutePath('/path/to/file')  // true
 * isAbsolutePath('./relative')      // false
 * isAbsolutePath('C:/Windows')      // true (Windows)
 */
export function isAbsolutePath(p: string): boolean {
  return path.isAbsolute(p);
}

/**
 * True if `p` is absolute on ANY platform — a POSIX root path (`/etc`), a
 * Windows drive-letter path (`C:\…` or `C:/…`), or a UNC path (`\\host\share`).
 *
 * Unlike {@link isAbsolutePath} (host-platform only), this is host-independent,
 * so config-containment checks reject Windows-absolute paths even when run on
 * POSIX CI, and vice versa. Used to keep config-supplied relative paths (skill
 * `files:` dest) from escaping their anchor directory (zip-slip class).
 *
 * @example
 * isAbsoluteAnyPlatform('/etc/passwd')   // true (POSIX)
 * isAbsoluteAnyPlatform('C:\\Users')      // true (Windows drive)
 * isAbsoluteAnyPlatform('scripts/cli')    // false (relative)
 */
export function isAbsoluteAnyPlatform(p: string): boolean {
  return path.posix.isAbsolute(p) || path.win32.isAbsolute(p);
}

/**
 * True if `p` contains a `..` parent-directory traversal segment.
 *
 * Forward-slash-normalized, then inspects each `/`-delimited segment — so a
 * `..` is caught regardless of the original OS separator. A containment guard
 * for config-supplied relative paths (skill `files:` dest values, glob magic
 * remainders) that must never climb above their anchor directory.
 *
 * @example
 * hasParentTraversalSegment('a/../b')      // true
 * hasParentTraversalSegment('a/b/c')       // false
 * hasParentTraversalSegment('..\\evil')     // true (backslash normalized)
 * hasParentTraversalSegment('a..b/c')      // false (".." must be a whole segment)
 */
export function hasParentTraversalSegment(p: string): boolean {
  return toForwardSlash(p).split('/').includes('..');
}

/**
 * Compute a `ValidationIssue.location`: an absolute source file path made
 * relative to the scan/project root, forward-slashed.
 *
 * This is the ONE relativizer every VAT validation lane uses. `location` is
 * contractually project-relative (see `ValidationIssue` in
 * `@vibe-agent-toolkit/agent-schema`), so producers must route through here
 * rather than emitting `skillPath` directly — absolute locations leak the
 * developer's home directory into CI logs and make `validation.allow` globs,
 * which match against `location`, unwritable.
 *
 * `projectRoot` is required precisely because "relative to what?" has no safe
 * default: a caller with no root must decide one (the skill directory, the
 * scan root) rather than silently falling back to an absolute path.
 *
 * @param sourceFilePath - Absolute path to the file the issue was found in.
 * @param projectRoot - Root the location is expressed relative to.
 * @returns Forward-slashed relative location.
 *
 * @example
 * issueLocation('/repo/skills/foo/SKILL.md', '/repo')  // 'skills/foo/SKILL.md'
 */
export function issueLocation(sourceFilePath: string, projectRoot: string): string {
  return toForwardSlash(path.relative(projectRoot, sourceFilePath));
}

/**
 * Convert a relative path to absolute
 *
 * If path is already absolute, returns it normalized.
 * Otherwise resolves relative to baseDir.
 *
 * @param p - Path to convert
 * @param baseDir - Base directory for resolution
 * @returns Absolute path with **forward slashes** (cross-platform safe)
 *
 * @example
 * toAbsolutePath('./docs/README.md', '/project')
 * // Returns: '/project/docs/README.md'
 *
 * toAbsolutePath('/absolute/path.md', '/project')
 * // Returns: '/absolute/path.md'
 */
export function toAbsolutePath(p: string, baseDir: string): string {
  if (path.isAbsolute(p)) {
    return toForwardSlash(path.normalize(p));
  }
  return toForwardSlash(path.resolve(baseDir, p));
}

/**
 * Get the relative path from one file to another
 *
 * Useful for generating relative links between markdown files.
 *
 * @param from - Source file path (absolute)
 * @param to - Target file path (absolute)
 * @returns Relative path from source to target with **forward slashes** (cross-platform safe)
 *
 * @example
 * getRelativePath('/project/docs/guide.md', '/project/README.md')
 * // Returns: '../README.md'
 *
 * getRelativePath('/project/README.md', '/project/docs/api.md')
 * // Returns: 'docs/api.md'
 */
export function getRelativePath(from: string, to: string): string {
  // Get directory of source file (not the file itself)
  const fromDir = path.dirname(from);

  // Calculate relative path from source directory to target file
  return toForwardSlash(path.relative(fromDir, to));
}

/**
 * Convert a path to forward slashes
 *
 * Windows accepts both forward slashes and backslashes as path separators.
 * This function normalizes all paths to use forward slashes for consistency.
 * Useful for glob pattern matching, cross-platform comparisons, and string operations.
 *
 * @param p - Path to convert
 * @returns Path with forward slashes
 *
 * @example
 * toForwardSlash('C:\\Users\\docs\\README.md')
 * // Returns: 'C:/Users/docs/README.md'
 *
 * toForwardSlash('/project/docs/README.md')
 * // Returns: '/project/docs/README.md' (unchanged)
 */
export function toForwardSlash(p: string): string {
  return p.replaceAll('\\', '/');
}

/**
 * Normalize text to Unicode NFC — the form in which two *visually identical*
 * filenames compare equal.
 *
 * `é` has two encodings: precomposed NFC (`U+00E9`) and decomposed NFD
 * (`e` + `U+0301`). They render identically and name the same file, yet they are
 * different strings, so `===`, `toLowerCase()`, `Map.get()` and `Set.has()` all
 * report them as different. `readdir` hands back whichever form is on disk —
 * APFS preserves what was written, and decomposed names are common on macOS —
 * while a markdown link typed in an editor almost always carries the composed
 * form. The two sides of a filename comparison therefore disagree about a file
 * that plainly exists.
 *
 * ⚠️ **This produces a COMPARISON KEY, never a path to open.** Do not normalize
 * a path on its way to `fs.*`. macOS would not notice — it is
 * normalization-*insensitive* at the syscall level, so `existsSync` answers the
 * same for either form — but Linux is not: on ext4 the two forms are simply
 * different byte sequences naming different files, so opening the normalized
 * form of a decomposed filename fails outright. That asymmetry is exactly why
 * this is not folded into {@link safePath.resolve}: its output is handed
 * straight to the filesystem. Normalize where two strings are *compared*, and
 * leave the string the filesystem receives alone.
 *
 * @param value - A filename, path segment, or whole path
 * @returns The same text in NFC. Pure ASCII is returned unchanged.
 *
 * @example
 * toNfc('cafe\u0301.md') === toNfc('caf\u00e9.md')  // true — same file, two encodings
 */
export function toNfc(value: string): string {
  return value.normalize('NFC');
}

/**
 * Cross-platform safe path operations.
 *
 * Wraps Node's `path.join()`, `path.resolve()`, and `path.relative()` to always
 * return forward-slash paths. On Windows, the native `path.*` functions return
 * backslashes, which causes bugs when paths are used as Map keys, compared as
 * strings, or matched with glob patterns.
 *
 * **Use these instead of importing from `node:path` directly.**
 * ESLint rules enforce this — see `no-path-join`, `no-path-resolve`, `no-path-relative`.
 *
 * @example
 * ```typescript
 * import { safePath } from '@vibe-agent-toolkit/utils';
 *
 * // Always forward slashes, even on Windows
 * safePath.join('C:\\Users', 'docs', 'file.md')          // → 'C:/Users/docs/file.md'
 * safePath.resolve('/project', './docs')                   // → '/project/docs'
 * safePath.relative('/project/docs', '/project')           // → '..'
 * safePath.joinUnderRoot('/harness', 'skill-abc')          // → '/harness/skill-abc'
 * safePath.joinUnderRoot('/harness', '../escape')          // throws Error
 * ```
 */
export const safePath = {
  /** Like `path.join()` but always returns forward slashes. */
  join(...paths: string[]): string {
    return toForwardSlash(path.join(...paths));
  },

  /** Like `path.resolve()` but always returns forward slashes. */
  resolve(...paths: string[]): string {
    return toForwardSlash(path.resolve(...paths));
  },

  /** Like `path.relative()` but always returns forward slashes. */
  relative(from: string, to: string): string {
    return toForwardSlash(path.relative(from, to));
  },

  /**
   * Join path segments under a security root, throwing if the result would escape.
   *
   * Resolves `root + segments` and verifies the result is strictly inside `root`
   * (or equal to it). Throws when any segment would cause the result to escape:
   *
   * - A `..` traversal that climbs above root
   * - An absolute POSIX path segment (e.g. `/etc/passwd`)
   * - A Windows drive-letter segment (e.g. `C:\Users\evil`)
   *
   * On success returns a forward-slash-normalized absolute path (consistent with
   * the other `safePath` helpers).
   *
   * **Use this instead of `safePath.join(root, segment)` whenever `segment` may
   * contain caller-controlled input** — this is the bug class that the original
   * skill-test staging code was vulnerable to on Windows.
   *
   * @returns Forward-slash absolute path guaranteed to be inside `root`.
   * @throws {Error} If the resolved path would escape `root`.
   *
   * @example
   * ```typescript
   * // ✅ Safe — throws if caller passes '../../../etc'
   * const dest = safePath.joinUnderRoot(harnessRoot, stagedDirName(item.name));
   *
   * // ❌ Unsafe — silently escapes on Windows with absolute segment
   * const dest = safePath.join(harnessRoot, item.name);
   * ```
   */
  joinUnderRoot(root: string, ...segments: string[]): string {
    // Eagerly reject any segment that is absolute (POSIX or Windows drive-letter)
    // BEFORE resolving, so the error message can name the offending segment.
    for (const seg of segments) {
      if (path.isAbsolute(seg)) {
        throw new Error(
          `safePath.joinUnderRoot: segment "${seg}" is absolute and escapes root "${root}".`,
        );
      }
      // Windows drive-letter check for POSIX hosts (path.isAbsolute won't catch
      // 'C:\...' on POSIX, but node's path.win32.isAbsolute does).
      if (path.win32.isAbsolute(seg)) {
        throw new Error(
          `safePath.joinUnderRoot: segment "${seg}" contains a Windows drive letter and escapes root "${root}".`,
        );
      }
    }

    const resolvedRoot = path.resolve(root);
    const resolvedResult = segments.length > 0
      ? path.resolve(resolvedRoot, ...segments)
      : resolvedRoot;

    // Containment check: normalize both to forward slashes so the comparison
    // is platform-independent and no path.sep is needed in string operations.
    const fwdRoot = toForwardSlash(resolvedRoot);
    const fwdResult = toForwardSlash(resolvedResult);
    // Result must equal root or start with root + '/' (not just startsWith(root)
    // which would match '/rootEvil' when root is '/root').
    const rootPrefix = fwdRoot.endsWith('/') ? fwdRoot : `${fwdRoot}/`;

    if (fwdResult !== fwdRoot && !fwdResult.startsWith(rootPrefix)) {
      throw new Error(
        `safePath.joinUnderRoot: result "${fwdResult}" escapes root "${fwdRoot}".`,
      );
    }

    return fwdResult;
  },
} as const;
