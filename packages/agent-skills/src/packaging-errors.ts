/**
 * The packager's refusal of a skill's own CONTENT — a `files:` entry whose
 * source is absent, unreadable, a directory or a glob matching nothing
 * shippable; a `SKILL.md` bundled as a resource; a name that is not one path
 * segment; a file the OS would not let the build read or write
 * (`withFsAttribution`). The adopter fixes these by editing the skill, its
 * config, or the permissions the message names.
 *
 * Coded at the throw so a caller can tell them apart from a defect in VAT
 * (an integrity post-condition failing), which stays an uncoded `Error`: dispatching on a message is how that distinction was
 * lost before.
 */

import { isVatError, VatError } from '@vibe-agent-toolkit/utils';

/** The `VatError` code of a packaging refusal of the skill's content. */
export const SKILL_PACKAGING_INPUT_INVALID_CODE = 'SKILL_PACKAGING_INPUT_INVALID';

/** The name-not-a-path-segment refusal `packageSkill` raises for an unusable skill name. */
export const SKILL_NAME_NOT_A_SEGMENT_CODE = 'SKILL_NAME_NOT_A_SEGMENT';

/**
 * A packaging refusal of the skill's content, carrying {@link SKILL_PACKAGING_INPUT_INVALID_CODE}.
 *
 * @param message - What the adopter must change, for a human
 * @param options - `cause`, as on a native Error
 */
export function packagingInputError(message: string, options?: ErrorOptions): VatError {
  return new VatError(SKILL_PACKAGING_INPUT_INVALID_CODE, message, options);
}

/**
 * Whether `error` is the packager refusing the skill's content (the adopter's
 * to fix), rather than a defect.
 *
 * @param error - What a caller of `packageSkill` caught
 */
export function isSkillPackagingInputError(error: unknown): boolean {
  return isVatError(error, SKILL_PACKAGING_INPUT_INVALID_CODE) || isVatError(error, SKILL_NAME_NOT_A_SEGMENT_CODE);
}
