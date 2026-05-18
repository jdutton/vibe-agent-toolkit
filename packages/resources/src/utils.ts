/**
 * Internal utility functions for the resources package.
 * These are not exported from the public API.
 */

import fs from 'node:fs';
import path from 'node:path';

import { toForwardSlash, safePath } from '@vibe-agent-toolkit/utils';
import picomatch from 'picomatch';

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
 * Check if a file path is within a project directory.
 *
 * Resolves symlinks before comparison to handle cases where symlinks
 * point outside the project directory.
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
  // Canonicalize both sides symmetrically. Asymmetric handling (realpath one
  // side, resolve the other) false-flags legitimate matches when projectRoot
  // traverses a symlink — e.g. macOS /tmp → /private/tmp, bind mounts.
  let resolvedFilePath: string;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- filePath is validated path parameter
    resolvedFilePath = fs.realpathSync(filePath);
  } catch {
    // If realpath fails, file doesn't exist - use original path
    resolvedFilePath = safePath.resolve(filePath);
  }

  let resolvedProjectRoot: string;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- projectRoot is validated path parameter
    resolvedProjectRoot = fs.realpathSync(projectRoot);
  } catch {
    resolvedProjectRoot = safePath.resolve(projectRoot);
  }

  // Normalize to forward slashes for cross-platform comparison
  const normalizedFile = toForwardSlash(resolvedFilePath);
  const normalizedRoot = toForwardSlash(resolvedProjectRoot);

  // Check if file path starts with project root
  // Add trailing slash to prevent false positives like:
  // /project-other starting with /project
  return normalizedFile.startsWith(normalizedRoot + '/') || normalizedFile === normalizedRoot;
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
