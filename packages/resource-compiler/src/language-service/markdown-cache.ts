/**
 * Cache for parsed markdown resources with mtime-based invalidation
 * Prevents re-parsing markdown files on every IDE operation
 */

import { statSync } from 'node:fs';

import type { MarkdownResource } from '../compiler/types.js';

interface CacheEntry {
  /** Parsed markdown resource */
  resource: MarkdownResource;
  /** File modification time (milliseconds since epoch) */
  mtime: number;
}

/**
 * Global cache of parsed markdown resources
 * Key: absolute file path
 * Value: cache entry with resource and mtime
 */
const cache = new Map<string, CacheEntry>();

/**
 * Get a cached markdown resource or load it using the provided loader
 * Invalidates cache if file has been modified since last load
 *
 * @param filePath - Absolute path to markdown file
 * @param loader - Function to load and parse the markdown file
 * @returns Parsed markdown resource
 *
 * @example
 * ```typescript
 * const resource = getMarkdownResource('/path/to/file.md', () => {
 *   const content = readFileSync('/path/to/file.md', 'utf-8');
 *   return parseMarkdown(content);
 * });
 * ```
 */
export function getMarkdownResource(
  filePath: string,
  loader: () => MarkdownResource,
): MarkdownResource {
  // Get current file modification time
  let currentMtime: number;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Using validated path from TypeScript Language Service
    const stats = statSync(filePath);
    currentMtime = stats.mtimeMs;
  } catch {
    // File doesn't exist or can't be accessed - always reload
    currentMtime = 0;
  }

  // Check if cached version is still valid
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
