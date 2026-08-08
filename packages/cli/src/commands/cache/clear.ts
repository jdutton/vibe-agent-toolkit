/**
 * `vat cache clear` — delete VAT's shared temp-directory cache tree.
 *
 * "Recovery is rescan" was true but had no user-invocable form: a corrupt or
 * merely stale cache could only be cleared by hand-deleting a path the docs
 * described in prose. This is that path, named once.
 *
 * Scope is the WHOLE `<tmpdir>/.vat-cache/` tree, not just the parse tenant.
 * That directory is shared — `external-links.json`, `auth-<user>/` and `parse/`
 * all live under it — and "clear the cache" cannot honestly mean "clear one of
 * the three". All of them are disposable by construction.
 */

import { type Dirent, promises as fs } from 'node:fs';
import { basename, dirname } from 'node:path';

import { parseCacheDirectory } from '@vibe-agent-toolkit/resources';
import { safePath } from '@vibe-agent-toolkit/utils';

import { handleCommandError } from '../../utils/command-error.js';
import { createLogger } from '../../utils/logger.js';
import { writeYamlOutput } from '../../utils/output.js';

/** The one name the shared cache root is allowed to have. See {@link vatCacheRoot}. */
const VAT_CACHE_DIR_NAME = '.vat-cache';

export interface CacheClearOptions {
  debug?: boolean;
}

/** What a clear did, as published on stdout. */
export interface CacheClearReport {
  status: 'success';
  cacheDir: string;
  existed: boolean;
  /** Top-level entries that were deleted, sorted. Empty when nothing was there. */
  removed: string[];
  entriesRemoved: number;
  bytesRemoved: number;
}

interface TreeUsage {
  entries: number;
  bytes: number;
}

const EMPTY_USAGE: TreeUsage = { entries: 0, bytes: 0 };

/**
 * The shared cache root, `<tmpdir>/.vat-cache`.
 *
 * Derived from `parseCacheDirectory()` rather than re-joining `normalizedTmpdir()`
 * with a third copy of the `.vat-cache` literal — one authority for where the
 * tree lives, and the CLI stays out of the path-resolution business.
 *
 * The name check is not decoration: this function's return value is handed
 * straight to a recursive delete, so if `parseCacheDirectory()` ever stopped
 * carrying a `parse/` leaf, the naive parent would be the system temp directory
 * itself. Refusing an unexpected shape turns that into an error instead of an
 * `rm -rf /tmp`.
 *
 * @returns Absolute path to the cache root
 * @throws {Error} If the derived parent is not named `.vat-cache`
 */
export function vatCacheRoot(): string {
  const parseDir = parseCacheDirectory();
  const root = dirname(parseDir);

  if (basename(root) !== VAT_CACHE_DIR_NAME) {
    throw new Error(
      `Refusing to clear ${root}: expected a directory named ${VAT_CACHE_DIR_NAME} (derived from ${parseDir}).`
    );
  }

  return root;
}

/**
 * Measure, then delete, an entire cache tree.
 *
 * Measured BEFORE the delete, because afterwards there is nothing left to count
 * and a report of "removed: unknown" would make the command unverifiable.
 *
 * Deliberately reads no environment: `vat cache clear` runs whether or not
 * caching is enabled for this process. A `VAT_CACHE=0` that also disarmed the
 * cleanup would leave an operator with a cache they can neither use nor remove.
 *
 * @param cacheDir - Directory to remove, in full
 * @returns What was removed
 */
export async function clearCacheDirectory(cacheDir: string): Promise<CacheClearReport> {
  const entries = await readdirOrNull(cacheDir);

  if (entries === null) {
    return { status: 'success', cacheDir, existed: false, removed: [], entriesRemoved: 0, bytesRemoved: 0 };
  }

  const usage = await measureEntries(cacheDir, entries);
  await fs.rm(cacheDir, { recursive: true, force: true });

  return {
    status: 'success',
    cacheDir,
    existed: true,
    removed: entries.map((entry) => entry.name).sort((a, b) => a.localeCompare(b)),
    entriesRemoved: usage.entries,
    bytesRemoved: usage.bytes,
  };
}

/**
 * Command entry point: clear the real cache root and publish the report.
 *
 * @param options - Command options (only `--debug`, inherited from the root)
 */
export async function cacheClearCommand(options: CacheClearOptions = {}): Promise<void> {
  const startTime = Date.now();
  const logger = createLogger(options.debug ? { debug: true } : {});

  try {
    const report = await clearCacheDirectory(vatCacheRoot());
    logger.debug(`Cleared ${String(report.entriesRemoved)} cache entries from ${report.cacheDir}`);
    writeYamlOutput(report);
    process.exit(0);
  } catch (error) {
    handleCommandError(error, logger, startTime, 'CacheClear');
  }
}

/**
 * `readdir` that reports a missing directory as `null` rather than throwing.
 *
 * Only ENOENT is absorbed. EACCES on a directory that exists is a genuine
 * failure — reporting it as "nothing to clear" would tell the operator their
 * cache is gone when it is still on disk.
 */
async function readdirOrNull(dir: string): Promise<Dirent[] | null> {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is the derived cache root or a caller-injected test directory
    return await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Sum file count and bytes over already-listed directory entries. */
async function measureEntries(
  dir: string,
  entries: Dirent[]
): Promise<TreeUsage> {
  const usages = await Promise.all(
    entries.map(async (entry) => {
      const child = safePath.join(dir, entry.name);
      // Not `isFile()`: a symlink or socket is still an entry that is about to
      // be removed, and counting only regular files would under-report it.
      return entry.isDirectory() ? measureTree(child) : { entries: 1, bytes: await sizeOf(child) };
    })
  );

  return usages.reduce(
    (total, usage) => ({ entries: total.entries + usage.entries, bytes: total.bytes + usage.bytes }),
    EMPTY_USAGE
  );
}

/** Recursive measure. A directory that vanished mid-walk contributes nothing. */
async function measureTree(dir: string): Promise<TreeUsage> {
  const entries = await readdirOrNull(dir);
  return entries === null ? EMPTY_USAGE : measureEntries(dir, entries);
}

/**
 * Size of one entry, without following symlinks.
 *
 * A file that disappears between the listing and the stat contributes 0 rather
 * than failing the clear — the whole tree is about to be deleted anyway, and a
 * concurrent vat run pruning its own temp file must not turn cleanup into an
 * error.
 */
async function sizeOf(target: string): Promise<number> {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is inside the cache root being measured
    const stats = await fs.lstat(target);
    return stats.size;
  } catch {
    return 0;
  }
}
