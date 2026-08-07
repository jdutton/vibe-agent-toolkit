import { mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { safePath } from './path-core.js';

/**
 * Re-export every pure path helper so the package barrel keeps exposing the
 * exact same surface it always has. The pure definitions themselves live in
 * `./path-core.ts`, which imports nothing but `node:path` — see that file's
 * header for why the split exists.
 *
 * This preserves the BARREL only. `@vibe-agent-toolkit/utils/fs` no longer
 * re-exports the pure helpers — they moved to `@vibe-agent-toolkit/utils/path`,
 * which is a breaking change for `./fs` consumers (see CHANGELOG and
 * `test/path-fs-subpaths.test.ts`).
 */
export * from './path-core.js';

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
 * @returns Real (normalized) path with **OS-native separators** (backslashes on Windows).
 * Use `toForwardSlash()` if you need forward slashes for string comparison or display.
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
 * @returns Normalized temp directory path with **OS-native separators** (resolves short names on Windows)
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
 * @returns Real (normalized) path to the created directory with **OS-native separators**
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
 * Resolve an OS-native absolute path from an ESM module's `import.meta.url` and
 * optional relative path segments.
 *
 * Safer than `new URL(rel, importMetaUrl).pathname`, which returns `/D:/...` on
 * Windows and breaks `fs` operations.
 *
 * @returns An **OS-native absolute path** (backslashes on Windows). Wrap with
 *   `toForwardSlash()` if you need forward slashes for display or comparison.
 *
 * @example
 * ```typescript
 * import { resolveFromImportMeta } from '@vibe-agent-toolkit/utils';
 *
 * const fixturePath = resolveFromImportMeta(import.meta.url, '../fixtures/data.yaml');
 * readFileSync(fixturePath, 'utf8');
 * ```
 */
export function resolveFromImportMeta(importMetaUrl: string, ...segments: string[]): string {
  if (segments.length === 0) {
    // fileURLToPath accepts the string directly; no need to round-trip through URL.
    return fileURLToPath(importMetaUrl);
  }
  // safePath.join gives forward slashes — URL spec requires them in relative refs.
  const relative = safePath.join(...segments);
  return fileURLToPath(new URL(relative, importMetaUrl));
}

/**
 * Dynamically import a module from an OS-native absolute filesystem path.
 *
 * Wraps `pathToFileURL()` because `await import(absPath)` fails on Windows —
 * ESM dynamic import requires a `file://` URL.
 *
 * @example
 * ```typescript
 * import { dynamicImportPath } from '@vibe-agent-toolkit/utils';
 *
 * const mod = await dynamicImportPath<{ default: Config }>(absConfigPath);
 * ```
 */
export async function dynamicImportPath<T = unknown>(absPath: string): Promise<T> {
  const mod: unknown = await import(pathToFileURL(absPath).href);
  return mod as T;
}
