/**
 * Collection matching: which collections a file belongs to.
 *
 * Applies include/exclude pattern rules with precedence (exclude wins).
 *
 * A collection's patterns are expanded and compiled once, by
 * {@link compileCollectionMatcher}; the predicate it returns is what every
 * caller matches with. There is no per-call form: a holder of a config compiles
 * it before its loop, so matching N files never compiles N times.
 */

import { basename as getBasename } from 'node:path';

import { countWork, toForwardSlash } from '@vibe-agent-toolkit/utils';
import picomatch from 'picomatch';

import { expandPatterns } from './pattern-expander.js';
import type { CollectionConfig } from './schemas/project-config.js';

/** Whether a file path belongs to the collection it was compiled from. */
export type CollectionMatcher = (filePath: string) => boolean;

/** The predicate of a pattern list that is empty: matches nothing. */
const MATCHES_NOTHING = (): boolean => false;

/**
 * Use dot:true so paths containing dotfile segments (e.g. .claude, .git) are matched correctly.
 * Without this option, picomatch ** does not descend into directories whose names start with a dot.
 */
const PICO_OPTIONS = { dot: true };

/**
 * Check if a pattern is a root-level pattern (e.g., *.md, *.json).
 *
 * Root-level patterns start with * but not **.
 */
function isRootLevelPattern(pattern: string): boolean {
  return pattern.startsWith('*') && !pattern.startsWith('**');
}

/** One pattern list compiled: root-level patterns test the basename, the rest the full path. */
interface CompiledPatterns {
  readonly path: (normalizedPath: string) => boolean;
  readonly basename: (basename: string) => boolean;
}

function compilePatterns(patterns: string[]): CompiledPatterns {
  const expanded = expandPatterns(patterns);
  const root = expanded.filter(isRootLevelPattern);
  const nonRoot = expanded.filter((pattern) => !isRootLevelPattern(pattern));
  return {
    path: nonRoot.length > 0 ? picomatch(nonRoot, PICO_OPTIONS) : MATCHES_NOTHING,
    basename: root.length > 0 ? picomatch(root, PICO_OPTIONS) : MATCHES_NOTHING,
  };
}

/**
 * Compile a collection's include/exclude rules into a predicate, once.
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
 * Every compile is counted `collection.matchers.compiled`.
 *
 * @param collection - Collection configuration with include/exclude patterns
 * @returns A predicate over absolute file paths: true if the file belongs to the collection
 *
 * @example
 * ```typescript
 * const inDocs = compileCollectionMatcher({
 *   include: ['docs'],
 *   exclude: ['**\/README.md']
 * });
 *
 * inDocs('/project/docs/guide.md')    // true
 * inDocs('/project/docs/README.md')   // false (excluded)
 * inDocs('/project/src/index.ts')     // false (not included)
 * ```
 */
export function compileCollectionMatcher(collection: CollectionConfig): CollectionMatcher {
  countWork('collection.matchers.compiled', 1);
  const include = compilePatterns(collection.include);
  const exclude = compilePatterns(collection.exclude ?? []);

  return (filePath: string): boolean => {
    const normalizedPath = toForwardSlash(filePath);
    const basename = getBasename(filePath);
    if (exclude.path(normalizedPath) || exclude.basename(basename)) {
      return false;
    }
    return include.path(normalizedPath) || include.basename(basename);
  };
}

/**
 * Compile every collection once, and return the question "which collections
 * does this file belong to?" — a file can belong to several.
 *
 * @param collections - Map of collection name to collection config
 * @returns For a file path, the names of the collections it belongs to, in declaration order
 *
 * @example
 * ```typescript
 * const collectionsFor = compileCollectionMembership({
 *   'rag-kb': { include: ['docs'], exclude: ['**\/README.md'] },
 *   'skills': { include: ['**\/SKILL.md'] }
 * });
 *
 * collectionsFor('/project/docs/guide.md')   // ['rag-kb']
 * collectionsFor('/project/docs/SKILL.md')   // ['rag-kb', 'skills']
 * ```
 */
export function compileCollectionMembership(
  collections: Readonly<Record<string, CollectionConfig>>,
): (filePath: string) => string[] {
  const matchers = Object.entries(collections).map(
    ([name, config]) => [name, compileCollectionMatcher(config)] as const,
  );
  return (filePath: string): string[] =>
    matchers.filter(([, matches]) => matches(filePath)).map(([name]) => name);
}
