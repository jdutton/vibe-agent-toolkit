/**
 * Internal utility functions for the resources package.
 * These are not exported from the public API.
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  toForwardSlash,
  safePath,
  realpathFrom,
  type RealpathTable,
} from '@vibe-agent-toolkit/utils';
import picomatch from 'picomatch';

/**
 * The root a `ValidationIssue.location` is expressed against when the caller
 * did not supply one.
 *
 * `location` is contractually project-relative, so "no root" is not an option —
 * something has to be chosen. The process CWD is the honest default for a
 * library entry point invoked without a project: it is the directory the paths
 * a user would type are relative to. Every VAT-internal caller passes a real
 * root, so this only ever applies to direct library consumers.
 */
export function locationRoot(projectRoot: string | undefined): string {
  return projectRoot ?? process.cwd();
}

/**
 * Check if a file path matches a glob pattern.
 *
 * Uses picomatch with Unix-style paths for cross-platform compatibility.
 * Implements two matching strategies:
 * 1. matchBase for simple filename patterns
 * 2. Segment-based matching for directory patterns
 *
 * @param filePath - File path to match (will be normalized to Unix-style)
 * @param pattern - Glob pattern to match against
 * @returns True if the path matches the pattern
 *
 * @example
 * ```typescript
 * matchesGlobPattern('/project/docs/README.md', 'docs/**')  // true
 * matchesGlobPattern('/project/src/index.ts', '*.md')       // false
 * ```
 */
export function matchesGlobPattern(filePath: string, pattern: string): boolean {
  const matcherWithBase = picomatch(pattern, { matchBase: true });
  const matcher = picomatch(pattern);
  const unixPath = toForwardSlash(filePath);

  // Strategy 1: Try with matchBase for simple filename matching
  if (matcherWithBase(unixPath)) {
    return true;
  }

  // Strategy 2: For directory patterns, try matching against path segments
  const segments = unixPath.split('/');
  for (let i = Math.min(10, segments.length); i > 0; i--) {
    const partialPath = segments.slice(-i).join('/');
    if (matcher(partialPath)) {
      return true;
    }
  }

  return false;
}

/**
 * Split an href into file path and anchor parts.
 *
 * @param href - The href to split (e.g., "./file.md#anchor")
 * @returns Tuple of [filePath, anchor], where anchor is undefined if no anchor exists
 *
 * @example
 * ```typescript
 * splitHrefAnchor('./file.md#heading')  // ['./file.md', 'heading']
 * splitHrefAnchor('./file.md')          // ['./file.md', undefined]
 * ```
 */
export function splitHrefAnchor(href: string): [string, string | undefined] {
  const anchorIndex = href.indexOf('#');
  if (anchorIndex === -1) {
    return [href, undefined];
  }

  const filePath = href.slice(0, anchorIndex);
  const anchor = href.slice(anchorIndex + 1);
  return [filePath, anchor];
}

/**
 * Discriminated union returned by {@link resolveLocalHref}.
 *
 * - `anchor_only` — the href was `#fragment` only (no file component).
 * - `resolved` — the href resolved to an absolute filesystem path.
 * - `absolute_no_root` — the href is an RFC 3986 §4.2 absolute-path
 *   reference (starts with `/`) but no `projectRoot` was supplied.
 * - `absolute_escapes_root` — the absolute-path reference resolved to a
 *   location outside `projectRoot` (e.g., via `..` traversal or a symlink
 *   pointing outside the project).
 */
export type ResolveLocalHrefResult =
  | { kind: 'anchor_only' }
  | { kind: 'resolved'; resolvedPath: string; anchor: string | undefined }
  | { kind: 'absolute_no_root'; href: string; anchor: string | undefined }
  | { kind: 'absolute_escapes_root'; href: string; anchor: string | undefined };

/**
 * Resolve a markdown link href to a filesystem path or a typed failure.
 *
 * Performs the standard href → path conversion used by both audit and validate:
 * 1. Strips anchor fragment (`#section`)
 * 2. Decodes URL-encoded characters (`%20` → space, `%26` → `&`)
 * 3. Resolves the path:
 *    - Leading `/` (RFC 3986 §4.2 absolute-path reference) → resolve against
 *      `projectRoot`. Requires a `projectRoot`; must not escape it.
 *    - Otherwise → resolve relative to the source file's directory.
 *
 * @param href - Raw href from a markdown link
 * @param sourceFilePath - Absolute path of the file containing the link
 * @param projectRoot - Optional project root for absolute-path references.
 * @returns A {@link ResolveLocalHrefResult} discriminating success vs failure modes.
 *
 * @example
 * ```typescript
 * resolveLocalHref('My%20Folder/doc.md#intro', '/project/README.md')
 * // { kind: 'resolved', resolvedPath: '/project/My Folder/doc.md', anchor: 'intro' }
 *
 * resolveLocalHref('#heading', '/project/README.md')
 * // { kind: 'anchor_only' }
 *
 * resolveLocalHref('/docs/foo.md', '/project/docs/sub/page.md', '/project')
 * // { kind: 'resolved', resolvedPath: '/project/docs/foo.md', anchor: undefined }
 * ```
 */
export function resolveLocalHref(
  href: string,
  sourceFilePath: string,
  projectRoot?: string,
): ResolveLocalHrefResult {
  const [fileHref, anchor] = splitHrefAnchor(href);
  if (fileHref === '') {
    return { kind: 'anchor_only' };
  }

  let decodedHref: string;
  try {
    decodedHref = decodeURIComponent(fileHref);
  } catch {
    decodedHref = fileHref;
  }

  // RFC 3986 §4.2 absolute-path reference — resolve against projectRoot.
  if (decodedHref.startsWith('/')) {
    if (!projectRoot) {
      return { kind: 'absolute_no_root', href: fileHref, anchor };
    }
    const candidate = safePath.resolve(projectRoot, decodedHref.slice(1));
    if (!isWithinProject(candidate, projectRoot)) {
      return { kind: 'absolute_escapes_root', href: fileHref, anchor };
    }
    return { kind: 'resolved', resolvedPath: candidate, anchor };
  }

  // Relative reference — resolve against the source file's directory.
  const sourceDir = path.dirname(sourceFilePath);
  const resolvedPath = safePath.resolve(sourceDir, decodedHref);
  return { kind: 'resolved', resolvedPath, anchor };
}

/**
 * The containment rule itself: is `normalizedFile` at or under `normalizedRoot`?
 *
 * Pure — **both arguments must already be canonical and forward-slashed**; this
 * normalizes nothing and touches no filesystem. The parameter names say so, and
 * are also what satisfies the `local/no-path-startswith` rule: the guarantee it
 * enforces is discharged by the two callers below, which canonicalize through
 * `toForwardSlash` (`canonicalizeSync`) or read an already-forward-slashed row
 * out of the filled table (`realpathFrom`).
 *
 * It exists so the two `isWithinProject*` forms share **one** definition of
 * containment. Two copies of the `startsWith(root + '/') || === root` pair would
 * be free to drift, and a drift here silently changes which links are reported
 * as gitignored leaks.
 */
function isUnderRoot(normalizedFile: string, normalizedRoot: string): boolean {
  // The trailing slash prevents false positives like `/project-other` reading
  // as being inside `/project`.
  return normalizedFile.startsWith(normalizedRoot + '/') || normalizedFile === normalizedRoot;
}

/**
 * Canonicalize one path synchronously, falling back to a plain resolve when the
 * path cannot be canonicalized (a path that does not exist has no realpath, and
 * a caller comparing paths still needs an answer).
 *
 * ⚠️ **Answers byte for byte what `FsLookupCache.realpath` answers, and that
 * equivalence is what makes {@link isWithinProject} and
 * {@link isWithinProjectFrom} interchangeable.** The reason is a deliberate
 * choice on the async side, not an accident of shape: **Node ships two different
 * realpaths and they do not agree.** `fs.realpathSync` (used here) and the
 * `fs.realpath` *callback* form run Node's own JS implementation — an
 * lstat/readlink walk that preserves the casing the caller asked for.
 * `fs/promises.realpath` and `fs.realpath.native` call `uv_fs_realpath`, which
 * reports the casing **on disk**. On a case-insensitive filesystem — macOS and
 * Windows — those are different strings, so a column filled through the native
 * route flips containment verdicts against this function and emits findings the
 * un-refactored code never emitted. `FsLookupCache.realpath` therefore
 * canonicalizes with `promisify(nodeFs.realpath)` **on purpose**; its docblock in
 * `packages/utils/src/fs-utils.ts` carries the measured three-way comparison and
 * names the test that pins it.
 *
 * Secondary observation, and explicitly NOT the argument: the *fallback*
 * branches agree too — the extra `toForwardSlash` applied here is a no-op,
 * because `safePath.resolve` already returns forward slashes. Comparing only the
 * fallbacks and assuming the success paths were the same function is exactly how
 * the native-route divergence above shipped green. The success paths are where
 * this equivalence has to be argued.
 *
 * Change either form and you must change the other, or the filled column and the
 * live syscall start answering differently.
 */
function canonicalizeSync(filePath: string): string {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- filePath is validated path parameter
    return toForwardSlash(fs.realpathSync(filePath));
  } catch {
    // Realpath failed — the path doesn't exist, so use the resolved path.
    return toForwardSlash(safePath.resolve(filePath));
  }
}

/**
 * Check if a file path is within a project directory — **the fill-pass form: it
 * costs two `fs.realpathSync`, one of them on the run-constant project root.**
 *
 * Canonicalizes both sides symmetrically before comparing. Asymmetric handling
 * (realpath one side, resolve the other) false-flags legitimate matches when
 * `projectRoot` traverses a symlink — e.g. macOS /tmp → /private/tmp, bind
 * mounts.
 *
 * ⚠️ **Judgement-time callers must use {@link isWithinProjectFrom} instead.**
 * This form is for the fill pass, where I/O is legal — today that means
 * {@link resolveLocalHref}'s absolute-path branch, which cannot be made
 * table-driven: the candidate path it asks about is derived by the resolution
 * itself, so no fill can know it in advance. Calling this from the judge is the
 * per-link syscall the realpath column exists to remove.
 *
 * @param filePath - Absolute path to check
 * @param projectRoot - Absolute path to project root
 * @returns True if filePath is under projectRoot (after symlink resolution)
 *
 * @example
 * ```typescript
 * isWithinProject('/project/docs/guide.md', '/project')  // true
 * isWithinProject('/external/data.md', '/project')       // false
 * isWithinProject('/project/link', '/project')           // depends on symlink target
 * ```
 */
export function isWithinProject(filePath: string, projectRoot: string): boolean {
  return isUnderRoot(canonicalizeSync(filePath), canonicalizeSync(projectRoot));
}

/**
 * The same containment question, answered out of an already-filled realpath
 * column. **Pure: no filesystem, no cache** — both canonical paths are read from
 * the table with `realpathFrom`.
 *
 * The judgement-time form. `projectRoot` is looked up like any other row, which
 * is the point: canonicalizing the run-constant root once per run instead of
 * once per link is half the syscalls this column removes.
 *
 * Exactly equivalent to {@link isWithinProject} — same comparison
 * ({@link isUnderRoot}), same canonicalization contract (see
 * {@link canonicalizeSync}).
 *
 * @param table - Table filled by `fillRealpaths`, covering BOTH paths
 * @param filePath - Absolute path to check
 * @param projectRoot - Absolute path to project root
 * @returns True if filePath is under projectRoot (after symlink resolution)
 * @throws If the table holds no row for either path — see `realpathFrom`
 */
export function isWithinProjectFrom(
  table: RealpathTable,
  filePath: string,
  projectRoot: string,
): boolean {
  return isUnderRoot(realpathFrom(table, filePath), realpathFrom(table, projectRoot));
}

/**
 * Escape a property name as a JSON Pointer segment per RFC 6901:
 * `~` -> `~0`, `/` -> `~1`. Order matters (escape `~` first).
 */
export function encodeJsonPointerSegment(name: string): string {
  return name.replaceAll('~', '~0').replaceAll('/', '~1');
}

/**
 * Reverse RFC 6901 escapes: `~1` -> `/`, `~0` -> `~`. Order matters
 * (unescape `~1` first).
 */
export function decodeJsonPointerSegment(segment: string): string {
  return segment.replaceAll('~1', '/').replaceAll('~0', '~');
}

/**
 * Format a JSON Pointer (RFC 6901) as developer-friendly dotted notation.
 *
 * Numeric segments become bracketed array indices (`0` → `[0]`); non-numeric
 * segments are dot-joined. Reverses RFC 6901 escapes inside segments.
 *
 * @example
 *   formatJsonPointerAsDotted('/adr-citations/0/adr')  // 'adr-citations[0].adr'
 *   formatJsonPointerAsDotted('')                       // ''
 */
export function formatJsonPointerAsDotted(pointer: string): string {
  if (pointer === '') return '';
  // eslint-disable-next-line local/no-hardcoded-path-split -- JSON Pointer RFC 6901 delimiter, not a file path
  const segments = pointer.slice(1).split('/').map(decodeJsonPointerSegment);

  let out = '';
  for (const seg of segments) {
    if (isCanonicalArrayIndex(seg)) {
      out += `[${seg}]`;
    } else {
      out += out === '' ? seg : `.${seg}`;
    }
  }
  return out;
}

export function isCanonicalArrayIndex(s: string): boolean {
  // Canonical integer per RFC 6901 §4 + JSON canonical form: no leading zeros
  // except for "0" itself.
  if (s === '') return false;
  if (s === '0') return true;
  if (s.startsWith('0')) return false;
  for (const ch of s) {
    if (ch < '0' || ch > '9') return false;
  }
  return true;
}
