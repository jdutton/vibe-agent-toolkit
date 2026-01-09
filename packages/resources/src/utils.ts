/**
 * Internal utility functions for the resources package.
 * These are not exported from the public API.
 */

import { toForwardSlash } from '@vibe-agent-toolkit/utils';
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
