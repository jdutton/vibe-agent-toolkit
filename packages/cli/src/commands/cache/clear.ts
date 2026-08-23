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

/**
 * What a clear did, as published on stdout.
 *
 * `partial` is not a failure mode bolted on — it is the *common* outcome when
 * something else on the machine is writing to the shared tree, and it has to be
 * reportable. A recursive delete that gives up part-way has already removed most
 * of the cache; surfacing that as a bare thrown error told the operator only
 * that the command failed, while leaving them to guess how much of their cache
 * still existed. An honest count of what went and what stayed is the whole
 * point of a report.
 */
export interface CacheClearReport {
  status: 'success' | 'partial';
  cacheDir: string;
  existed: boolean;
  /** Top-level entries that are gone, sorted. Empty when nothing was there. */
  removed: string[];
  /** Top-level entries that survived a partial clear, sorted. Absent on success. */
  remaining?: string[];
  /** Why the delete stopped short. Absent on success. */
  reason?: string;
  entriesRemoved: number;
  bytesRemoved: number;
}

interface TreeUsage {
  entries: number;
  bytes: number;
}

const EMPTY_USAGE: TreeUsage = { entries: 0, bytes: 0 };

/**
 * Retry budget for the recursive delete.
 *
 * Not defensive padding — observed. `<tmpdir>/.vat-cache` is shared by every VAT
 * on the machine: other worktrees, other sessions, and any adopter running an
 * *installed* vat all write into it under their own namespace. A `vat cache
 * clear` issued while one of them is mid-run walks a tree that is growing
 * underneath it and `rmdir` fails `ENOTEMPTY` on a shard that gained a file
 * between the listing and the removal. Reproduced twice against a concurrent
 * `vat verify`; the same command succeeded immediately once that run finished.
 *
 * Node retries exactly this error class (`EBUSY`, `EMFILE`, `ENFILE`,
 * `ENOTEMPTY`, `EPERM`) with a linear backoff, which clears a short overlap.
 * It cannot win against a writer that keeps going for the whole window — that
 * case still surfaces as an error, which is correct: "some of your cache is
 * gone and something is still writing" must not be reported as success.
 */
const RM_RETRY: { maxRetries: number; retryDelay: number } = { maxRetries: 5, retryDelay: 100 };

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
 * ⚠ `@vibe-agent-toolkit/resources` now also exports a `vatCacheRoot()`, and
 * `parseCacheDirectory()` is built from it — so on paper this derivation is a
 * round trip. It is kept deliberately: the guard's job is to notice if that
 * relationship ever changes, and importing the root directly would retire the
 * only check standing between a shape change and a recursive delete of
 * `<tmpdir>` itself. Deriving-then-verifying is the point.
 *
 * ✅ **It has now earned that keep.** When the cache gained a per-build
 * namespace, the layout went from `.vat-cache/parse` to
 * `.vat-cache/<namespace>/parse` and the old single-`dirname` derivation
 * started returning `.vat-cache/<namespace>`. The name check turned a silent
 * change of delete target into a loud refusal. Anyone tempted to simplify this
 * into an import should read that sentence twice.
 *
 * @returns Absolute path to the cache root
 * @throws {Error} If the derived ancestor is not named `.vat-cache`
 */
export function vatCacheRoot(): string {
  const parseDir = parseCacheDirectory();
  // Up two: `<root>/<namespace>/parse` → `<root>`. The namespace level is what
  // makes this two rather than one; see the note above about why it is still
  // derived and verified rather than imported.
  const root = dirname(dirname(parseDir));

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
  const names = entries.map((entry) => entry.name);

  try {
    await fs.rm(cacheDir, { recursive: true, force: true, ...RM_RETRY });
  } catch (error) {
    return partialReport(cacheDir, names, usage, error);
  }

  return {
    status: 'success',
    cacheDir,
    existed: true,
    removed: sorted(names),
    entriesRemoved: usage.entries,
    bytesRemoved: usage.bytes,
  };
}

/**
 * Describe a delete that stopped part-way, by re-reading the tree.
 *
 * The survivors are read back off disk rather than inferred from the error,
 * because the error names one path and says nothing about the other ninety-nine
 * percent. Re-measuring what remains and subtracting is the only way the counts
 * describe what actually happened rather than what was attempted.
 *
 * A concurrent writer can make the remainder *larger* than the original
 * measurement, so the subtraction is floored at zero: reporting a negative
 * number of removed bytes would be worse than reporting none.
 *
 * @param cacheDir - The tree that was being removed
 * @param names - Top-level entry names as they were before the delete
 * @param before - Usage measured before the delete
 * @param error - Whatever `fs.rm` threw
 * @returns A report naming what went, what stayed, and why
 */
async function partialReport(
  cacheDir: string,
  names: string[],
  before: TreeUsage,
  error: unknown,
): Promise<CacheClearReport> {
  const survivors = (await readdirOrNull(cacheDir)) ?? [];
  const remaining = new Set(survivors.map((entry) => entry.name));
  const after = await measureEntries(cacheDir, survivors);

  return {
    status: 'partial',
    cacheDir,
    existed: true,
    removed: sorted(names.filter((name) => !remaining.has(name))),
    remaining: sorted([...remaining]),
    reason: error instanceof Error ? error.message : String(error),
    entriesRemoved: Math.max(0, before.entries - after.entries),
    bytesRemoved: Math.max(0, before.bytes - after.bytes),
  };
}

/** Stable ordering for the reported entry lists. */
function sorted(names: readonly string[]): string[] {
  return [...names].sort((left, right) => left.localeCompare(right));
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
    // A partial clear publishes its report and *then* fails. Exiting through
    // `handleCommandError` instead would suppress the report entirely, which is
    // the defect this branch exists to fix: the operator most needs to know how
    // much of the cache survived precisely when the command did not finish.
    process.exit(report.status === 'partial' ? 1 : 0);
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
