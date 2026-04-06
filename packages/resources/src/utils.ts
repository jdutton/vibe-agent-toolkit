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
 * Resolve a markdown link href to an absolute filesystem path.
 *
 * Performs the standard href → path conversion used by both audit and validate:
 * 1. Strips anchor fragment (`#section`)
 * 2. Decodes URL-encoded characters (`%20` → space, `%26` → `&`)
 * 3. Resolves the path relative to the source file's directory
 *
 * Returns `null` for anchor-only links (e.g., `#heading`).
 *
 * @param href - Raw href from a markdown link
 * @param sourceFilePath - Absolute path of the file containing the link
 * @returns Resolved path info, or null for anchor-only links
 *
 * @example
 * ```typescript
 * resolveLocalHref('My%20Folder/doc.md#intro', '/project/README.md')
 * // { resolvedPath: '/project/My Folder/doc.md', anchor: 'intro' }
 *
 * resolveLocalHref('#heading', '/project/README.md')
 * // null
 * ```
 */
export function resolveLocalHref(
  href: string,
  sourceFilePath: string,
): { resolvedPath: string; anchor: string | undefined } | null {
  const [fileHref, anchor] = splitHrefAnchor(href);
  if (fileHref === '') {
    return null;
  }

  let decodedHref: string;
  try {
    decodedHref = decodeURIComponent(fileHref);
  } catch {
    decodedHref = fileHref;
  }

  const sourceDir = path.dirname(sourceFilePath);
  const resolvedPath = safePath.resolve(sourceDir, decodedHref);

  return { resolvedPath, anchor };
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
  // Resolve symlinks to get real paths
  let resolvedFilePath: string;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- filePath is validated path parameter
    resolvedFilePath = fs.realpathSync(filePath);
  } catch {
    // If realpath fails, file doesn't exist - use original path
    resolvedFilePath = safePath.resolve(filePath);
  }

  const resolvedProjectRoot = safePath.resolve(projectRoot);

  // Normalize to forward slashes for cross-platform comparison
  const normalizedFile = toForwardSlash(resolvedFilePath);
  const normalizedRoot = toForwardSlash(resolvedProjectRoot);

  // Check if file path starts with project root
  // Add trailing slash to prevent false positives like:
  // /project-other starting with /project
  return normalizedFile.startsWith(normalizedRoot + '/') || normalizedFile === normalizedRoot;
}
