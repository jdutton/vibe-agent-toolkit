/**
 * The marketplace build's filesystem work, coded by the tree it touches.
 *
 * A copy reads one tree and writes another, and its errno names neither side:
 * `EACCES` is raised for an unreadable LICENSE and for a read-only `dist/` alike.
 * So every copy is two steps — the source is opened for reading first (the
 * build's INPUT, `INPUT_UNREADABLE`), and only then is the destination written
 * (the build's OUTPUT, `RUN_INCOMPLETE`: a full disk, a read-only `dist/`, a file
 * in the way). Neither is a defect in VAT, so neither is `INTERNAL_ERROR`.
 *
 * Coded as `VatError`s rather than command refusals so the tree copy, which the
 * refusal map itself imports, can use them without an import cycle.
 */

import { closeSync, cpSync, openSync, statSync } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { isFilesystemAccessError, isVatError, openEachFileForReading, safePath, toForwardSlash, VatError } from '@vibe-agent-toolkit/utils';

/** A file the marketplace build must read and the OS will not let it. Published `INPUT_UNREADABLE`. */
export const MARKETPLACE_SOURCE_UNREADABLE_CODE = 'MARKETPLACE_SOURCE_UNREADABLE';

/** A marketplace write the OS refused. Published `RUN_INCOMPLETE`: the run stopped, nothing is wrong with a plugin. */
export const MARKETPLACE_WRITE_FAILED_CODE = 'MARKETPLACE_WRITE_FAILED';

/**
 * One write into the marketplace tree this build owns (`dist/.claude/plugins/…`).
 * A refusal from the OS is the run stopping, naming what it was doing. An
 * already-coded refusal, and a non-filesystem throw, pass through untouched.
 *
 * @param what - Completes "Could not …", naming the path
 */
export async function writingMarketplace<T>(what: string, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (isVatError(error) || !isFilesystemAccessError(error)) throw error;
    throw new VatError(
      MARKETPLACE_WRITE_FAILED_CODE,
      `Could not ${what}: ${(error as Error).message}. Check that dist/ is writable and that there is space on the device.`,
      { cause: error },
    );
  }
}

/**
 * Open `path` for reading — and, for a directory, every file beneath it — and
 * close it again. A refusal is the build's input, naming the file. A symbolic
 * link inside a directory is not read through: what follows it is the copy's call.
 *
 * @param path - Absolute path to the file or directory the build will read
 * @param label - How a refusal names `path` (project-relative, never absolute)
 * @param remedy - What the operator does about it
 */
function requireReadableSource(path: string, label: string, remedy: string): void {
  try {
    if (statSync(path).isDirectory()) {
      openEachFileForReading(path);
    } else {
      closeSync(openSync(path, 'r'));
    }
  } catch (error) {
    if (!isFilesystemAccessError(error)) throw error;
    const failed = (error as NodeJS.ErrnoException).path;
    const which = failed === undefined || toForwardSlash(failed) === toForwardSlash(path)
      ? label
      : `${label}/${safePath.relative(path, failed)}`;
    throw new VatError(
      MARKETPLACE_SOURCE_UNREADABLE_CODE,
      `Could not read ${which}: ${(error as Error).message}. ${remedy}`,
      { cause: error },
    );
  }
}

/** Remedy for a source file the author keeps: fix its permissions. */
const SOURCE_FILE_REMEDY = "Check the file's permissions and ownership, and that every directory above it is traversable.";

/**
 * Copy one file into the marketplace tree: read side first, then the write.
 *
 * @param source - Absolute path the build reads
 * @param target - Absolute path in the marketplace tree
 * @param sourceLabel - How a read refusal names `source`
 * @param targetLabel - How a write refusal names `target`
 */
export async function copyFileIntoMarketplace(
  source: string,
  target: string,
  sourceLabel: string,
  targetLabel: string,
): Promise<void> {
  requireReadableSource(source, sourceLabel, SOURCE_FILE_REMEDY);
  await writingMarketplace(`write ${targetLabel}`, async () => {
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
  });
}

/**
 * Copy a directory tree into the marketplace tree: every file is opened for
 * reading first (`remedy` names the fix), then the copy is written.
 *
 * @param source - Absolute directory the build reads
 * @param target - Absolute directory in the marketplace tree
 * @param sourceLabel - How a read refusal names `source`
 * @param targetLabel - How a write refusal names `target`
 * @param remedy - What the operator does about an unreadable file under `source`
 */
export async function copyTreeIntoMarketplace(
  source: string,
  target: string,
  sourceLabel: string,
  targetLabel: string,
  remedy: string,
): Promise<void> {
  requireReadableSource(source, sourceLabel, remedy);
  await writingMarketplace(`copy ${sourceLabel} into ${targetLabel}`, async () => {
    await mkdir(target, { recursive: true });
    cpSync(source, target, { recursive: true });
  });
}
