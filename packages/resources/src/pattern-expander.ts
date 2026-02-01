/**
 * Pattern expansion utilities for converting paths to glob patterns.
 *
 * Expands directory paths to glob patterns while preserving explicit glob patterns.
 */

const DEFAULT_EXTENSIONS = '**/*.{md,json}';

/**
 * Check if a string is a glob pattern or a plain path.
 *
 * A string is considered a glob pattern if it contains glob metacharacters.
 *
 * @param pattern - String to check
 * @returns True if string contains glob metacharacters
 *
 * @example
 * ```typescript
 * isGlobPattern('docs')                    // false
 * isGlobPattern('docs/**\/*.md')           // true
 * isGlobPattern('**\/*.json')              // true
 * isGlobPattern('path/to/file.md')         // false
 * ```
 */
export function isGlobPattern(pattern: string): boolean {
  return /[*?[\]{}]/.test(pattern);
}

/**
 * Expand a path to a glob pattern.
 *
 * - If input already starts with **\/ or is absolute (starts with /), return as-is
 * - If input is a glob pattern without **\/, prepend **\/ to match absolute paths
 * - If input is a path, expand to **\/path/**\/*.{md,json}
 * - Trailing slashes are stripped before expansion
 * - The **\/ prefix ensures patterns match absolute paths from any location
 *
 * Note: Patterns are expected to use forward slashes. Use toForwardSlash() on paths before
 * passing to this function if they might contain backslashes (Windows).
 *
 * @param pathOrPattern - Path or glob pattern (with forward slashes)
 * @returns Expanded glob pattern
 *
 * @example
 * ```typescript
 * expandPattern('docs')                    // '**\/docs/**\/*.{md,json}'
 * expandPattern('docs/')                   // '**\/docs/**\/*.{md,json}'
 * expandPattern('docs/**\/*.md')           // '**\/docs/**\/*.md' (prepend **\/)
 * expandPattern('**\/*.schema.json')       // '**\/*.schema.json' (unchanged)
 * expandPattern('*.md')                    // '*.md' (root-level pattern, no prefix)
 * ```
 */
export function expandPattern(pathOrPattern: string): string {
  // Note: This function expects pattern strings (from config), not file paths.
  // Pattern strings from YAML config should already use forward slashes (YAML standard).
  // This function doesn't normalize because it operates on pattern syntax, not paths.

  // If already starts with **/ or is absolute, return as-is
  // Pattern strings are always forward-slash based (YAML/config standard)
  // eslint-disable-next-line local/no-path-startswith -- checking pattern syntax, not paths
  if (pathOrPattern.startsWith('**/') || pathOrPattern.startsWith('/')) {
    return pathOrPattern;
  }

  // If it's a glob pattern
  if (isGlobPattern(pathOrPattern)) {
    // Root-level patterns (*.md, *.json) should match only root level
    // These are purely glob metacharacters, not paths
    // eslint-disable-next-line local/no-path-startswith -- checking pattern syntax, not paths
    if (pathOrPattern.startsWith('*')) {
      return pathOrPattern;
    }
    // Other glob patterns need **/ prefix to match absolute paths
    return `**/${pathOrPattern}`;
  }

  // Strip trailing slash for plain paths
  const normalizedPath = pathOrPattern.replace(/\/$/, '');

  // Expand path to pattern with **/ prefix for absolute path matching
  return `**/${normalizedPath}/${DEFAULT_EXTENSIONS}`;
}

/**
 * Expand an array of paths/patterns to glob patterns.
 *
 * Each item is processed individually using expandPattern().
 *
 * @param patterns - Array of paths or glob patterns
 * @returns Array of expanded glob patterns
 *
 * @example
 * ```typescript
 * expandPatterns(['docs', 'src/**\/*.ts', 'README.md'])
 * // ['docs/**\/*.{md,json}', 'src/**\/*.ts', 'README.md/**\/*.{md,json}']
 * ```
 */
export function expandPatterns(patterns: string[]): string[] {
  return patterns.map(expandPattern);
}
