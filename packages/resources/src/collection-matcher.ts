/**
 * Collection matching utilities for determining which collections a file belongs to.
 *
 * Applies include/exclude pattern rules with precedence (exclude wins).
 */

import { basename as getBasename } from 'node:path';

import { toForwardSlash } from '@vibe-agent-toolkit/utils';
import picomatch from 'picomatch';

import { expandPatterns } from './pattern-expander.js';
import type { CollectionConfig } from './schemas/project-config.js';

/**
 * Check if a pattern is a root-level pattern (e.g., *.md, *.json).
 *
 * Root-level patterns start with * but not **.
 */
function isRootLevelPattern(pattern: string): boolean {
  return pattern.startsWith('*') && !pattern.startsWith('**');
}

/**
 * Check if a file path matches a collection's include/exclude rules.
 *
 * Rules:
 * - File must match at least one include pattern
 * - File must NOT match any exclude pattern
 * - Exclude always wins over include
 * - Pattern order does not matter
 *
 * Special handling for root-level patterns (*.md, *.json):
 * - These match against the basename only, not the full path
 * - Allows matching root-level files regardless of their absolute path
 *
 * Paths are normalized to forward slashes before matching for cross-platform consistency.
 *
 * @param filePath - Absolute file path to check
 * @param collection - Collection configuration with include/exclude patterns
 * @returns True if file belongs to collection
 *
 * @example
 * ```typescript
 * const collection = {
 *   include: ['docs'],
 *   exclude: ['**\/README.md']
 * };
 *
 * matchesCollection('/project/docs/guide.md', collection)    // true
 * matchesCollection('/project/docs/README.md', collection)   // false (excluded)
 * matchesCollection('/project/src/index.ts', collection)     // false (not included)
 * ```
 */
export function matchesCollection(filePath: string, collection: CollectionConfig): boolean {
  // Normalize to forward slashes for cross-platform consistency
  const normalizedPath = toForwardSlash(filePath);

  // Extract basename for root-level pattern matching
  const basename = getBasename(filePath);

  // Expand patterns (paths → globs)
  const includePatterns = expandPatterns(collection.include);
  const excludePatterns = collection.exclude ? expandPatterns(collection.exclude) : [];

  // Separate root-level patterns from other patterns
  const includeRootPatterns = includePatterns.filter(isRootLevelPattern);
  const includeNonRootPatterns = includePatterns.filter((p) => !isRootLevelPattern(p));

  const excludeRootPatterns = excludePatterns.filter(isRootLevelPattern);
  const excludeNonRootPatterns = excludePatterns.filter((p) => !isRootLevelPattern(p));

  // Check excludes first (exclude wins)
  // Check non-root excludes against full path
  if (excludeNonRootPatterns.length > 0) {
    const excludeMatcher = picomatch(excludeNonRootPatterns);
    if (excludeMatcher(normalizedPath)) {
      return false;
    }
  }

  // Check root-level excludes against basename
  if (excludeRootPatterns.length > 0) {
    const excludeRootMatcher = picomatch(excludeRootPatterns);
    if (excludeRootMatcher(basename)) {
      return false;
    }
  }

  // Check includes (need to match at least one)
  let matched = false;

  // Check non-root includes against full path
  if (includeNonRootPatterns.length > 0) {
    const includeMatcher = picomatch(includeNonRootPatterns);
    if (includeMatcher(normalizedPath)) {
      matched = true;
    }
  }

  // Check root-level includes against basename
  if (!matched && includeRootPatterns.length > 0) {
    const includeRootMatcher = picomatch(includeRootPatterns);
    if (includeRootMatcher(basename)) {
      matched = true;
    }
  }

  return matched;
}

/**
 * Find all collections that a file belongs to.
 *
 * A file can belong to multiple collections if it matches their rules.
 *
 * @param filePath - Absolute file path to check
 * @param collections - Map of collection name to collection config
 * @returns Array of collection names the file belongs to
 *
 * @example
 * ```typescript
 * const collections = {
 *   'rag-kb': { include: ['docs'], exclude: ['**\/README.md'] },
 *   'skills': { include: ['**\/SKILL.md'] }
 * };
 *
 * getCollectionsForFile('/project/docs/guide.md', collections)
 * // ['rag-kb']
 *
 * getCollectionsForFile('/project/docs/SKILL.md', collections)
 * // ['rag-kb', 'skills']
 * ```
 */
export function getCollectionsForFile(
  filePath: string,
  collections: Record<string, CollectionConfig>
): string[] {
  const matchingCollections: string[] = [];

  for (const [name, config] of Object.entries(collections)) {
    if (matchesCollection(filePath, config)) {
      matchingCollections.push(name);
    }
  }

  return matchingCollections;
}
