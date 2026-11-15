/**
 * Cache for parsed markdown resources with mtime-based invalidation
 * Prevents re-parsing markdown files on every IDE operation
 */

import { followedStatSync } from '@vibe-agent-toolkit/utils';

import type { MarkdownResource } from '../compiler/types.js';

interface CacheEntry {
  /** Parsed markdown resource */
  resource: MarkdownResource;
  /** File modification time (milliseconds since epoch) */
  mtime: number;
}

/** Parsed markdown resources by absolute file path. */
const cache = new Map<string, CacheEntry>();

/**
 * Get a cached markdown resource or load it using the provided loader
 * Invalidates cache if file has been modified since last load
 *
 * @param filePath - Absolute path to markdown file
 * @param within - The tree it is read in (the importing file's directory)
 * @param loader - Function to load and parse the markdown file
 * @returns Parsed markdown resource
 *
 * @example
 * ```typescript
 * const resource = getMarkdownResource('/path/to/file.md', '/path/to', () => {
 *   const content = readFileSync('/path/to/file.md', 'utf-8');
 *   return toMarkdownResource(content);
 * });
 * ```
 */
export function getMarkdownResource(
  filePath: string,
  within: string,
  loader: () => MarkdownResource,
): MarkdownResource {
  // Get current file modification time. A file that is not there caches under
  // mtime 0 (the loader decides what an absent file means). A file the OS
  // refuses to stat must NOT share that slot (it throws): cached once under
  // the same key as an absent one, it would never be reloaded once its
  // permissions were fixed. The language-service entry points catch and log.
  const currentMtime = followedStatSync(filePath, within)?.mtimeMs ?? 0;

  const cached = cache.get(filePath);
  if (cached?.mtime === currentMtime) {
    return cached.resource;
  }

  // Load and cache the resource
  const resource = loader();
  cache.set(filePath, { resource, mtime: currentMtime });

  return resource;
}

/**
 * Clear the entire cache
 * Useful for testing or manual cache invalidation
 */
export function clearCache(): void {
  cache.clear();
}

/**
 * Remove a specific file from the cache
 * Useful when a file is deleted or moved
 *
 * @param filePath - Absolute path to markdown file
 */
export function invalidateFile(filePath: string): void {
  cache.delete(filePath);
}

/**
 * Get cache statistics for debugging
 *
 * @returns Object with cache size and list of cached files
 */
export function getCacheStats(): { size: number; files: string[] } {
  return {
    size: cache.size,
    files: [...cache.keys()],
  };
}
