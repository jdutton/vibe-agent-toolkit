import path from 'node:path';

/**
 * Normalize a path for cross-platform comparison
 *
 * - Converts to absolute path (if baseDir provided)
 * - Normalizes separators (/ vs \)
 * - Resolves . and ..
 * - Removes trailing slashes
 *
 * @param p - Path to normalize
 * @param baseDir - Optional base directory for relative path resolution
 * @returns Normalized absolute path
 *
 * @example
 * normalizePath('./docs/../README.md', '/project')
 * // Returns: '/project/README.md'
 */
export function normalizePath(p: string, baseDir?: string): string {
  // Resolve to absolute if baseDir provided, otherwise just normalize
  const resolved = baseDir ? path.resolve(baseDir, p) : path.normalize(p);

  // Normalize path separators and remove trailing slashes
  // Use simple non-backtracking pattern
  let normalized = resolved;
  while (normalized.endsWith('/') || normalized.endsWith('\\')) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
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
 * Convert a relative path to absolute
 *
 * If path is already absolute, returns it normalized.
 * Otherwise resolves relative to baseDir.
 *
 * @param p - Path to convert
 * @param baseDir - Base directory for resolution
 * @returns Absolute path
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
    return path.normalize(p);
  }
  return path.resolve(baseDir, p);
}

/**
 * Get the relative path from one file to another
 *
 * Useful for generating relative links between markdown files.
 *
 * @param from - Source file path (absolute)
 * @param to - Target file path (absolute)
 * @returns Relative path from source to target
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
  return path.relative(fromDir, to);
}

/**
 * Convert a path to Unix-style forward slashes
 *
 * Useful for glob pattern matching, which expects forward slashes.
 * On Windows, path.resolve() and path.normalize() return backslashes,
 * but glob matchers like picomatch expect forward slashes by default.
 *
 * @param p - Path to convert
 * @returns Path with forward slashes
 *
 * @example
 * toUnixPath('C:\\Users\\docs\\README.md')
 * // Returns: 'C:/Users/docs/README.md'
 *
 * toUnixPath('/project/docs/README.md')
 * // Returns: '/project/docs/README.md' (unchanged on Unix)
 */
export function toUnixPath(p: string): string {
  return p.replaceAll('\\', '/');
}
