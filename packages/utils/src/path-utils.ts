import { mkdirSync, realpath, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { isFinalPathUnanswerableError, isPathAbsentError } from './errors/errno-table.js';
import { classifyFsFault } from './errors/fs-fault.js';
import { safePath, toForwardSlash } from './path-core.js';
import { assertLocalChain } from './tree-change/host-chain.js';
import { HOST_PATH_FLAVOR } from './tree-change/link-chain.js';

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
 * `realpathSync.native(target)`, or `target` itself when there is nothing at
 * that path to canonicalize.
 *
 * Absence is the ONLY failure answered with the lexical path: `normalizePath`
 * is documented to accept a path that does not exist, and a path that does not
 * exist has no realpath. Everything else — `EACCES` on an ancestor, `ELOOP` on
 * a symlink cycle, `ENAMETOOLONG` — is the filesystem refusing a path that IS
 * there. Those used to come back as the lexical spelling with nothing to say
 * so, which put a lexical path where every caller compares canonical ones: a
 * containment check judged such a path by the spelling the OS had just refused
 * to resolve. They stay loud.
 *
 * Only when the native call AND the JS walk agree that nothing is there is the
 * lexical path the answer — the one fallback rule every native site shares
 * ({@link nativeAnswerNeedsJsWalk}), here with native separators kept.
 */
function realpathOrSelf(target: string): string {
  try {
    return realpathNativeRawSync(target);
  } catch (error) {
    if (isPathAbsentError(error)) return target;
    throw error;
  }
}

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

  // Native OS realpath first (resolves Windows short names); a path that is not
  // there is answered with `resolved` — better than the original input.
  return realpathOrSelf(resolved);
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
 * @throws FsFaultError on side `environment` when the OS refuses to resolve the temp directory
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
  const tmp = tmpdir();
  try {
    return realpathOrSelf(tmp);
  } catch (error: unknown) {
    // Every verb roots its scratch, staging and caches here: a refusal is VAT's scratch space failing.
    throw classifyFsFault(error, { side: 'environment', action: 'resolve the temporary directory', path: tmp });
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
  mkdirSync(dirPath, options);

  return realpathOrSelf(dirPath);
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

/**
 * Whether a native realpath's failure must be asked again of Node's JS realpath
 * before anyone believes it — the ONE fallback rule every native site shares
 * (`realpathNativeSync`, `realpathNative`, `normalizePath`'s `realpathOrSelf`, the
 * file crawler's identity check). They used to hold two: `realpathOrSelf` fell
 * back on absence and an unanswerable volume, the exported pair on the latter
 * only, so one dangling-looking path got two answers on a host where they differ.
 *
 * - A volume whose driver does not implement final-path queries (a RAM disk, some
 *   redirectors and virtual drives) answers EVERY native realpath with
 *   `ERROR_INVALID_FUNCTION`, which libuv reports as `EISDIR`
 *   ({@link isFinalPathUnanswerableError}). That says nothing about the path.
 * - An absent answer ({@link isPathAbsentError}) is confirmed by the JS walk:
 *   Node's docs note that on a musl libc without procfs the native `realpath(3)`
 *   cannot work at all and reports `ENOENT` for a path that exists, and Windows
 *   answers `ENOENT` (`ERROR_PATH_NOT_FOUND`) for a file on a volume mounted into
 *   a folder with no drive letter, which has no DOS name to give (pinned on a
 *   real host by `realpath-native-folder-mount.integration.test.ts`). A path the
 *   JS walk also finds absent throws the walk's own `ENOENT`, so nothing that is
 *   really missing reads as present.
 *
 * ⚠️ The JS answer is not the on-disk spelling, and that is NOT fail-closed on
 * every host. It keeps the casing the caller spelled (and, on Windows, an 8.3
 * short name); on POSIX a mis-cased spelling of an in-root path compares OUTSIDE a
 * canonical root, but on Windows `safePath.relative` (`path.win32.relative`)
 * ignores case, so it compares inside — right on a case-insensitive volume, wrong
 * in a directory marked case-sensitive. And the JS walk expands only what `lstat`
 * calls a link: a `subst` drive and a volume mount point (`\??\Volume{GUID}\`,
 * which libuv reports as a plain directory) stay as spelled, so one file has two
 * spellings that compare either way, depending on how the root was spelled. No
 * lane walks a mount point differently from a directory today; a caller that
 * needs the kernel's own identity compares `stat` identities, not these strings.
 *
 * @param error - What the native realpath threw
 * @returns True when the JS walk decides instead
 */
function nativeAnswerNeedsJsWalk(error: unknown): boolean {
  return isFinalPathUnanswerableError(error) || isPathAbsentError(error);
}

/**
 * `realpathSync.native` with native separators, asked again of the JS realpath
 * under the one fallback rule ({@link nativeAnswerNeedsJsWalk}) — and asked at
 * all only once the link chain to `path` has been read, hop by hop, and shown
 * to be local ({@link assertLocalChain}): a Windows kernel resolving a link to
 * `\\host\share` offers the operator's NTLM credentials to that host before any
 * answer comes back, so the kernel is the second lock, never the first.
 *
 * @param path - Path to resolve
 * @returns The real path, in the host's own separators
 * @throws LinkChainRefusedError for a chain through a network path, or one that never ends; the JS
 *   walk's error when it is asked and fails, else the native error
 */
function realpathNativeRawSync(path: string): string {
  assertLocalChain(path, HOST_PATH_FLAVOR);
  try {
    return realpathSync.native(path);
  } catch (error: unknown) {
    if (!nativeAnswerNeedsJsWalk(error)) throw error;
    return realpathSync(path);
  }
}

/**
 * The native realpath — the canonical ON-DISK spelling (`realpath(3)` /
 * `GetFinalPathNameByHandleW`) — forward-slashed, under the one fallback rule
 * ({@link nativeAnswerNeedsJsWalk}).
 *
 * @param path - Path to resolve
 * @returns The real path, forward-slashed
 * @throws The resolution's own error otherwise — the caller classifies it
 */
export function realpathNativeSync(path: string): string {
  return toForwardSlash(realpathNativeRawSync(path));
}

/**
 * The asynchronous {@link realpathNativeSync} (`realpath.native`).
 *
 * @param path - Path to resolve
 * @returns The real path, forward-slashed
 * @throws The resolution's own error otherwise — the caller classifies it
 */
export async function realpathNative(path: string): Promise<string> {
  assertLocalChain(path, HOST_PATH_FLAVOR);
  try {
    return toForwardSlash(await promisify(realpath.native)(path));
  } catch (error: unknown) {
    if (!nativeAnswerNeedsJsWalk(error)) throw error;
    return toForwardSlash(await promisify(realpath)(path));
  }
}
