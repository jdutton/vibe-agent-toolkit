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

import { isFilesystemAccessError } from '@vibe-agent-toolkit/utils';

/** For a failure that moved bytes INTO the bundle. */
export const WRITE_REMEDY =
  "Check the file's permissions and ownership, that the output directory is writable, "
  + 'and that there is space on the device.';

/** For a failure that only tried to READ the author's own tree. */
export const READ_REMEDY =
  "Check the file's permissions and ownership, and that every directory above it is traversable.";

/**
 * Run filesystem work, and if the OS refuses it, say what was being attempted.
 *
 * @param subject What the build was doing, phrased so it names something the
 *   author can locate — a `files:` entry, a linked file, a skill. This is the
 *   whole point: the errno already has the path.
 * @param action What was being done to it, completing "it could not be …".
 *   Defaults to the copy case; the integrity lane passes its own, because telling
 *   an author a file "could not be copied" when the copy SUCCEEDED and the
 *   verification failed sends them to look at the wrong step.
 * @param remedy What to check. Split from `action` because the two do not track
 *   each other: a failed READ has nothing to do with whether the output directory
 *   is writable or the disk is full, and padding a message with checks that
 *   cannot apply teaches people to stop reading the message.
 *
 * A non-filesystem throw is rethrown untouched. Re-wrapping a defect in our own
 * code as "check your permissions" would send the author to fix something that is
 * not theirs to fix — and it is the same "make the tool quietest when it is most
 * wrong" shape the audit walk's guard exists to avoid.
 */
export async function withFsAttribution<T>(
  subject: string,
  work: () => Promise<T>,
  action = 'copied into the bundle',
  remedy = WRITE_REMEDY,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (!isFilesystemAccessError(error)) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${subject}, but it could not be ${action}: ${reason}. ${remedy}`,
    );
  }
}
