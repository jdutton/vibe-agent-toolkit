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

import { VatError } from './errors/vat-error.js';

/**
 * Thrown by {@link safePath.joinUnderRoot} when the joined path would land
 * outside its root.
 *
 * A class with a code rather than a prefixed sentence: three packages used to
 * recognise this refusal with `error.message.startsWith('safePath.joinUnderRoot:')`,
 * which is a contract on prose. Dispatch with
 * `isVatError(error, PathEscapesRootError.code)` — it survives the `src`/`dist`
 * boundary that `instanceof` does not.
 */
export class PathEscapesRootError extends VatError {
  /** The code every instance carries, for `isVatError(error, PathEscapesRootError.code)`. */
  static readonly code = 'PATH_ESCAPES_ROOT';

  /**
   * @param root - The root the path had to stay under
   * @param detail - Which segment, or which result, escaped it
   */
  constructor(root: string, detail: string) {
    super(PathEscapesRootError.code, `safePath.joinUnderRoot: ${detail} escapes root "${root}".`);
  }
}

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
 * Backslashes are read as separators on every host (the input is author-written
 * config), then each `/`-delimited segment is inspected — so a `..` is caught
 * regardless of the separator the author typed. A containment guard
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
  // eslint-disable-next-line local/no-dotdot-containment -- this IS the one lexical `..`-segment test the rule points to; it classifies a config-supplied RELATIVE spelling before any root exists to ask the filesystem about. Sinks use isUnderRoot().
  return toForwardSlashAnyPlatform(p).split('/').includes('..');
}

/**
 * True when a root-relative path — as `safePath.relative(root, p)` spells it —
 * names something the root does not contain.
 *
 * The three shapes `path.relative` can return for an outsider: the parent
 * itself (`..`), a climb through it (`../x`), and, on Windows only, an
 * absolute path (a target on another drive has no relative spelling). A name
 * that merely BEGINS with two dots (`..notes.md`) is a member and reads as one;
 * the bare `startsWith('..')` this replaces refused it, dropped the file from
 * the package and unlinked the reference, at exit 0.
 *
 * ⚠️ **Lexical, on purpose.** This classifies a relative path that was already
 * computed; it does not ask the filesystem, so a symlink inside the root that
 * points outside reads as inside here. That is the right answer for the
 * callers that own no root to ask about — a projection identity, a permission
 * pattern, a report relativizer — and the WRONG one for a delete or copy sink,
 * which must ask {@link isUnderRoot} from `@vibe-agent-toolkit/utils` instead.
 * The empty relative (the root itself) is not an escape; whether equality is
 * acceptable is the caller's question and is asked beside this one.
 *
 * @param normalizedRelative - A forward-slashed root-relative path
 * @returns True when the root does not contain it
 *
 * @example
 * relativeEscapesRoot(safePath.relative(root, p))   // the whole idiom
 * relativeEscapesRoot('../x')       // true
 * relativeEscapesRoot('..notes.md') // false — a member whose name starts with dots
 */
export function relativeEscapesRoot(normalizedRelative: string): boolean {
  // eslint-disable-next-line local/no-dotdot-containment -- this IS the one lexical relative-path classifier the rule points to; every former copy of this pair now calls here. Sinks use isUnderRoot().
  return normalizedRelative === '..' || normalizedRelative.startsWith('../') || isAbsoluteAnyPlatform(normalizedRelative);
}

/** A Windows drive-relative spelling (`C:`) — `path.resolve` sends it to that drive's cwd. */
const DRIVE_RELATIVE = /^[A-Za-z]:/u;

/**
 * True when `name` can only ever be ONE directory entry under whatever it is
 * joined to: non-empty, not `.` or `..`, no separator of either platform, no
 * NUL, no drive-letter prefix.
 *
 * The check for a caller-controlled NAME — a skill name from a manifest, a
 * session id, a positional the user typed — that is about to become
 * `join(root, name)`. A name is not a path: `..cache` and `a..b` are legitimate
 * entries, and `includes('..')` refused them while `startsWith` let `x/../..`
 * through. The question is whether the join can land anywhere but directly
 * under `root`, and that is answered by the segment's shape alone, with no
 * filesystem — which is also why this belongs beside the path helpers rather
 * than beside {@link isUnderRoot}, which is the check for a PATH.
 *
 * @param name - The proposed entry name
 * @returns True when `join(root, name)` is a direct child of `root`
 *
 * @example
 * isSingleFsSegment('my-skill')   // true
 * isSingleFsSegment('..cache')    // true — dots inside a name are just dots
 * isSingleFsSegment('../victim')  // false
 * isSingleFsSegment('..')         // false
 */
export function isSingleFsSegment(name: string): boolean {
  return (
    name !== '' &&
    name !== '.' &&
    name !== '..' &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.includes('\0') &&
    !DRIVE_RELATIVE.test(name)
  );
}

/**
 * Compute a `ValidationIssue.location`: an absolute source file path made
 * relative to the scan/project root, forward-slashed.
 *
 * This is the ONE relativizer every VAT validation lane uses. `location` is
 * contractually project-relative (see `ValidationIssue` in
 * `@vibe-agent-toolkit/schema`), so producers must route through here
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

/** True on hosts (win32) where a backslash is a path separator; everywhere else it is a filename character. */
const BACKSLASH_IS_NATIVE_SEPARATOR = path.sep === '\\';

/**
 * Convert a NATIVE path — one the filesystem, `path.*`, `readdir` or git
 * handed you — to forward slashes.
 *
 * Converts only where a backslash is a separator (win32). On POSIX a backslash is a
 * legal filename character, so `docs/x\y.md` is one file and is returned
 * unchanged: converting it would invent a phantom `docs/x/` directory and, in
 * {@link safePath.joinUnderRoot}, turn an `x\..\..` NAME into a climb.
 *
 * For AUTHOR-WRITTEN text — an href, a glob, a config value, a CLI argument,
 * an archive entry name — whose backslashes must read as separators on every
 * host, use {@link toForwardSlashAnyPlatform}.
 *
 * @param p - A native path
 * @returns The path with forward slashes (identity on POSIX)
 *
 * @example
 * toForwardSlash('C:\\Users\\docs\\README.md') // win32: 'C:/Users/docs/README.md'
 * toForwardSlash('docs/x\\y.md')                // POSIX: 'docs/x\\y.md' (unchanged)
 */
export function toForwardSlash(p: string): string {
  return BACKSLASH_IS_NATIVE_SEPARATOR ? toForwardSlashAnyPlatform(p) : p;
}

/**
 * Convert every backslash to a forward slash, on every host.
 *
 * For AUTHOR-WRITTEN text that may carry Windows spellings regardless of where
 * VAT runs — markdown hrefs, globs, config values, CLI arguments, zip entry
 * names — and for containment guards that must refuse `..\x` everywhere.
 * Never use it on a path read from the filesystem or git: on POSIX that
 * backslash is part of a filename. Use {@link toForwardSlash} for those.
 *
 * @param text - Author-written path text
 * @returns The text with every backslash replaced by `/`
 *
 * @example
 * toForwardSlashAnyPlatform('..\\evil')   // '../evil' on every host
 */
export function toForwardSlashAnyPlatform(text: string): string {
  // eslint-disable-next-line local/no-manual-path-normalize -- this IS the converter the rule's autofix writes; it cannot call itself.
  return text.replaceAll('\\', '/');
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
 * return forward-slash paths (converted through {@link toForwardSlash}, so a
 * backslash inside a POSIX filename survives). On Windows, the native `path.*` functions return
 * backslashes, which causes bugs when paths are used as Map keys, compared as
 * strings, or matched with glob patterns.
 *
 * **Use these instead of importing from `node:path` directly.**
 * An ESLint rule enforces this — see `no-raw-node-path` (its `functions` option
 * table maps each of `join`/`resolve`/`relative` to its `safePath.*` replacement).
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
 * safePath.joinUnderRoot('/harness', '../escape')          // throws PathEscapesRootError
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
   * @throws {PathEscapesRootError} If the resolved path would escape `root`.
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
        throw new PathEscapesRootError(root, `segment "${seg}" is absolute and`);
      }
      // Windows drive-letter check for POSIX hosts (path.isAbsolute won't catch
      // 'C:\...' on POSIX, but node's path.win32.isAbsolute does).
      if (path.win32.isAbsolute(seg)) {
        throw new PathEscapesRootError(root, `segment "${seg}" contains a Windows drive letter and`);
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
      throw new PathEscapesRootError(fwdRoot, `result "${fwdResult}"`);
    }

    return fwdResult;
  },
} as const;
