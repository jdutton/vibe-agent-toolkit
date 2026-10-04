/**
 * One home for "the filesystem refused this, and here is what you were doing".
 *
 * A build moves files for several different reasons — a `files:` entry, a link
 * the walker followed, an integrity re-read — and each of those used to let a raw
 * errno escape as the whole explanation. `EACCES: permission denied, open
 * '/abs/path'` names a path and nothing else: not which line of config asked for
 * it, not which skill was being built, not what to do next.
 *
 * That defect was fixed five times in a row, one call site at a time, and each
 * fix was correct and none of them was the class. The lesson is not "add a
 * try/catch here too" — it is that the message format has to have exactly one
 * home, so a new copier inherits it by calling this rather than by remembering to
 * reproduce it.
 *
 * Deliberately NOT in `files-config.ts`: this is not about `files:` config. That
 * module wraps this with its own subject phrasing, as does the link-copy path in
 * the packager, and both get identical structure with a subject that fits.
 */

import { copyFile, mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';

import { isFilesystemAccessError } from '@vibe-agent-toolkit/utils';

import { packagingInputError, packagingOutputError } from './packaging-errors.js';

/** For a failure that moved bytes INTO the bundle. */
export const WRITE_REMEDY =
  "Check the file's permissions and ownership, that the output directory is writable, "
  + 'and that there is space on the device.';

/** For a failure that only tried to READ the author's own tree. */
export const READ_REMEDY =
  "Check the file's permissions and ownership, and that every directory above it is traversable.";

/**
 * Which tree the guarded work touches: the author's `source`; the build's
 * `output` root, a path the operator chose (`--output`, `dist/`); or a path
 * inside the `bundle`, whose layout the skill's own config decides.
 *
 * It decides the CODE, so it is required — a refusal is coded at its cause, and
 * the cause is known only at the call site. The errno cannot say: `EACCES` is
 * raised for an unreadable source and for an unwritable output directory alike,
 * and `ENOTDIR` for a file in the way of `--output` and for one `files:` dest
 * landing under another's file alike.
 */
export type FsSide = 'source' | 'output' | 'bundle';

/**
 * Errnos that, raised INSIDE the bundle, still describe the skill: the layout its
 * config asked for cannot exist — one `files:` dest landing on, or under,
 * another's file. No disk or permission is involved, and a rerun fails the same way.
 * Never applied to the output root: the operator chose that path, not the skill.
 */
const BUNDLE_LAYOUT_ERRNOS: ReadonlySet<unknown> = new Set(['EEXIST', 'ENOTDIR', 'EISDIR']);

/**
 * Run filesystem work, and if the OS refuses it, say what was being attempted.
 *
 * @param subject What the build was doing, phrased so it names something the
 *   author can locate — a `files:` entry, a linked file, a skill. This is the
 *   whole point: the errno already has the path.
 * @param side Which tree `work` touches. Work that touches both is split by the
 *   caller ({@link copyIntoBundle}), never guessed here — so `work` must not
 *   itself contain a guarded call for the other side: the errno is read down the
 *   `cause` chain, and an outer guard would re-code the inner refusal as its own.
 * @param action What was being done to it, completing "it could not be …".
 *   Defaults to the copy case; the integrity lane passes its own, because telling
 *   an author a file "could not be copied" when the copy SUCCEEDED and the
 *   verification failed sends them to look at the wrong step.
 *
 * What it throws is CODED by `side`, the original error as `cause`:
 * - `source` — a packaging refusal of the skill's content (`packagingInputError`):
 *   the adopter's to fix, published by every packaging lane as a
 *   `SKILL_PACKAGING_FAILED` finding (`isSkillPackagingInputError`).
 * - `output` — `packagingOutputError`: a full disk, a read-only or unwritable
 *   output directory, a file in the way of the output path. Nothing about the
 *   skill is wrong, so it is never that finding; the run did not finish.
 * - `bundle` — as `output`, except for an errno that says the bundle's own layout
 *   is impossible ({@link BUNDLE_LAYOUT_ERRNOS}), which the skill's config
 *   decides: that stays the skill's.
 *
 * The remedy follows the side too: a failed READ has nothing to do with whether
 * the output directory is writable or the disk is full, and padding a message
 * with checks that cannot apply teaches people to stop reading the message.
 *
 * A non-filesystem throw is rethrown untouched. Re-wrapping a defect in our own
 * code as "check your permissions" would send the author to fix something that is
 * not theirs to fix — and it is the same "make the tool quietest when it is most
 * wrong" shape the audit walk's guard exists to avoid.
 */
export async function withFsAttribution<T>(
  subject: string,
  side: FsSide,
  work: () => Promise<T>,
  action = 'copied into the bundle',
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (!isFilesystemAccessError(error)) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    if (side === 'source') {
      throw packagingInputError(`${subject}, but it could not be ${action}: ${reason}. ${READ_REMEDY}`, { cause: error });
    }
    const message = `${subject}, but it could not be ${action}: ${reason}. ${WRITE_REMEDY}`;
    throw side === 'bundle' && BUNDLE_LAYOUT_ERRNOS.has((error as { code?: unknown }).code)
      ? packagingInputError(message, { cause: error })
      : packagingOutputError(message, { cause: error });
  }
}

/**
 * Prove `path` readable by opening it for reading and closing it.
 *
 * Never `access(R_OK)`: Node documents that on Windows it ignores ACLs, so an
 * ACL-denied source passed it and then failed inside the copy, under the guard of
 * the wrong side.
 *
 * @param path A file the build is about to read
 */
export async function proveReadable(path: string): Promise<void> {
  const handle = await open(path, 'r');
  await handle.close();
}

/**
 * Copy one file into the bundle, creating the directory it lands in.
 *
 * A copy touches both trees and its errno names neither, so the two sides are
 * separate steps: the source is checked for reading first (the `source` side),
 * and only then is the destination made and written (the `bundle` side).
 *
 * @param subject As {@link withFsAttribution}
 * @param sourcePath The author's file
 * @param targetPath Where it lands in the bundle
 */
export async function copyIntoBundle(subject: string, sourcePath: string, targetPath: string): Promise<void> {
  await withFsAttribution(subject, 'source', () => proveReadable(sourcePath));
  await withFsAttribution(subject, 'bundle', async () => {
    await mkdir(dirname(targetPath), { recursive: true });
    await copyFile(sourcePath, targetPath);
  });
}
