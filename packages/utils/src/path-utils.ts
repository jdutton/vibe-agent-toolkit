import { mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Normalize any path (resolve short names on Windows)
 *
 * Resolves Windows 8.3 short names (e.g., RUNNER~1) and symlinks.
 * Accepts multiple path segments like path.resolve() for convenience.
 *
 * **Why this matters:**
 * - Windows may create paths with short names (8.3 format)
 * - Node.js operations may use long names while paths contain short names
 * - This causes path comparison failures and existsSync() issues
 * - realpathSync.native() resolves these to their actual filesystem paths
 *
 * @param paths - Path segments to join and normalize
 * @returns Real (normalized) path, or resolved path if normalization fails
 *
 * @example
 * ```typescript
 * // Single path
 * const shortPath = 'C:\\PROGRA~1\\nodejs';
 * const longPath = normalizePath(shortPath);
 * // Result: 'C:\\Program Files\\nodejs'
 *
 * // Multiple segments (like path.resolve)
 * const cliPath = normalizePath(__dirname, '../../dist/bin.js');
 * // Resolves to absolute path AND normalizes short names
 *
 * // Backward compatible with old signature
 * normalizePath('./docs/../README.md', '/project')
 * // Returns: '/project/README.md' (normalized)
 * ```
 */
export function normalizePath(...paths: string[]): string {
  // Handle single relative path without filesystem resolution
  if (paths.length === 1 && paths[0] && !path.isAbsolute(paths[0])) {
    return path.normalize(paths[0]);
  }

  // Resolve to absolute path
  // For 2 args: treat as (relativePath, baseDir) - reverse for path.resolve(baseDir, relativePath)
  // For 3+ args or single absolute: use as-is
  let resolved: string;
  if (paths.length === 1) {
    resolved = paths[0] ?? '';
  } else if (paths.length === 2) {
    resolved = path.resolve(paths[1] ?? '', paths[0] ?? '');
  } else {
    resolved = path.resolve(...paths);
  }

  try {
    // Use native OS realpath for better Windows compatibility
    return realpathSync.native(resolved);
  } catch {
    // Fallback to regular realpathSync
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Safe: resolved is from path.resolve
      return realpathSync(resolved);
    } catch {
      // Last resort: return resolved path (better than original input)
      return resolved;
    }
  }
}

/**
 * Get normalized temp directory path
 *
 * On Windows, tmpdir() may return 8.3 short names like:
 * - C:\Users\RUNNER~1\AppData\Local\Temp
 *
 * This function returns the real (long) path:
 * - C:\Users\runneradmin\AppData\Local\Temp
 *
 * **Why this matters:**
 * - Node.js operations create directories with LONG names
 * - Tests using SHORT paths from tmpdir() will fail existsSync() checks
 * - This is a "works on Mac, fails on Windows CI" bug pattern
 *
 * @returns Normalized temp directory path (resolves short names on Windows)
 *
 * @example
 * ```typescript
 * // ❌ WRONG - May return short path on Windows
 * const testDir = join(tmpdir(), 'test-dir');
 *
 * // ✅ RIGHT - Always returns real path
 * const testDir = join(normalizedTmpdir(), 'test-dir');
 * ```
 */
export function normalizedTmpdir(): string {
  const temp = tmpdir();
  try {
    // Use native OS realpath for better Windows compatibility
    return realpathSync.native(temp);
  } catch {
    // Fallback to regular realpathSync
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Safe: temp is from tmpdir()
      return realpathSync(temp);
    } catch {
      // Last resort: return original
      return temp;
    }
  }
}

/**
 * Create directory and return normalized path
 *
 * Combines mkdirSync + realpathSync to ensure the returned path
 * matches the actual filesystem path (resolves Windows short names).
 *
 * **Why this matters:**
 * - After mkdirSync(), the path might not match what filesystem uses
 * - On Windows, short path input creates long path output
 * - Subsequent existsSync() checks with original path may fail
 *
 * @param path - Directory path to create
 * @param options - Options for mkdirSync (e.g., recursive: true)
 * @returns Real (normalized) path to the created directory
 *
 * @example
 * ```typescript
 * // ❌ WRONG - Path mismatch on Windows
 * const testDir = join(tmpdir(), 'test-dir');
 * mkdirSync(testDir, { recursive: true });
 * // testDir might be: C:\Users\RUNNER~1\...\test-dir
 * // But filesystem created: C:\Users\runneradmin\...\test-dir
 *
 * // ✅ RIGHT - Normalized path guaranteed
 * const testDir = mkdirSyncReal(
 *   join(tmpdir(), 'test-dir'),
 *   { recursive: true }
 * );
 * // testDir is now: C:\Users\runneradmin\...\test-dir (real path)
 * ```
 */
export function mkdirSyncReal(
  dirPath: string,
  options?: Parameters<typeof mkdirSync>[1]
): string {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- This IS the mkdirSyncReal() implementation
  mkdirSync(dirPath, options);

  try {
    // Use native OS realpath for better Windows compatibility
    return realpathSync.native(dirPath);
  } catch {
    // Fallback to regular realpathSync
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Safe: dirPath is function parameter
      return realpathSync(dirPath);
    } catch {
      // Last resort: return original
      return dirPath;
    }
  }
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
 * Convert a path to forward slashes
 *
 * Windows accepts both forward slashes and backslashes as path separators.
 * This function normalizes all paths to use forward slashes for consistency.
 * Useful for glob pattern matching, cross-platform comparisons, and string operations.
 *
 * @param p - Path to convert
 * @returns Path with forward slashes
 *
 * @example
 * toForwardSlash('C:\\Users\\docs\\README.md')
 * // Returns: 'C:/Users/docs/README.md'
 *
 * toForwardSlash('/project/docs/README.md')
 * // Returns: '/project/docs/README.md' (unchanged)
 */
export function toForwardSlash(p: string): string {
  return p.replaceAll('\\', '/');
}
