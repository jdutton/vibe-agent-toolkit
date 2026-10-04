/**
 * A skill source tree the OS will not let VAT read while hashing or staging it —
 * an unreadable file or an unlistable directory in a `--with name=path:<dir>`
 * companion, say. That is the operator's input, not a defect in VAT, so it is
 * coded at the read and named; `vat skill test run` publishes it as
 * `INPUT_UNREADABLE` (`SKILL_TEST_REFUSAL_BY_ERROR_CODE`).
 */

import { isFilesystemAccessError, VatError } from '@vibe-agent-toolkit/utils';

/** The `VatError` code of a skill source the OS will not read. */
export const SKILL_SOURCE_UNREADABLE_CODE = 'SKILL_SOURCE_UNREADABLE';

/** A skill source the OS will not read. Reason `preflight`: the operator fixes the permissions. */
export class SkillSourceUnreadableError extends VatError {
  readonly reason = 'preflight' as const;
  constructor(message: string, options?: ErrorOptions) {
    super(SKILL_SOURCE_UNREADABLE_CODE, message, options);
  }
}

/**
 * Run a read of `path` in a skill source, coding an OS refusal as
 * {@link SkillSourceUnreadableError} naming the path. Anything else is rethrown.
 *
 * @param path - The file or directory being read
 * @param read - The read
 */
export async function readingSkillSource<T>(path: string, read: () => T | Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (!isFilesystemAccessError(error)) throw error;
    throw new SkillSourceUnreadableError(
      `Cannot read the skill source at ${path} (${(error as NodeJS.ErrnoException).code ?? 'unknown error'}). `
        + "Check the file's permissions and ownership, and that every directory above it is traversable.",
      { cause: error },
    );
  }
}
