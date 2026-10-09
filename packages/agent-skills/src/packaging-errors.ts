/**
 * The packager's refusal of a skill's own CONTENT — a `files:` entry whose
 * source is absent, a directory or a glob matching nothing shippable; a
 * `SKILL.md` bundled as a resource; a name that is not one path segment. The
 * adopter fixes these by editing the skill or its config.
 *
 * A filesystem fault is classified once, by `classifyFsFault`, and is never
 * re-coded here: a source the OS will not let the build read is an
 * `FsFaultError` on the `source` side, and a write into the bundle whose layout
 * the skill's `files:` config decided is classified with `shapeFromSource`, so an
 * impossible layout (`wrong-type`, `occupied`: one dest on or under another's
 * file) lands on the source side too. The build's OUTPUT refusing a write — a
 * full disk, a read-only or unwritable output directory, an output removed
 * mid-run — is a `destination` fault: it says nothing about the skill.
 *
 * Coded at the throw so a caller can tell them apart from a defect in VAT
 * (an integrity post-condition failing), which stays an uncoded `Error`: dispatching on a message is how that distinction was
 * lost before.
 */

import type { ValidationIssue } from '@vibe-agent-toolkit/schema';
import { type FsFaultClass, isFsFaultError, isVatError, VatError } from '@vibe-agent-toolkit/utils';

import type { PackageSkillResult } from './skill-packager.js';

/** The `VatError` code of a packaging refusal of the skill's content. */
export const SKILL_PACKAGING_INPUT_INVALID_CODE = 'SKILL_PACKAGING_INPUT_INVALID';

/** The `VatError` code of a package its own post-build checks failed ({@link SkillPackageChecksFailedError}). */
export const SKILL_PACKAGE_CHECKS_FAILED_CODE = 'SKILL_PACKAGE_CHECKS_FAILED';

/** The error-severity findings of a package's post-build checks, both channels. */
function errorFindingsOf(result: PackageSkillResult): ValidationIssue[] {
  return [...(result.postBuildIssues ?? []), ...(result.postBuildValidation?.allErrors ?? [])]
    .filter((issue) => issue.severity === 'error');
}

/**
 * A package whose own post-build checks emitted an error: it was discarded, NOTHING was written,
 * and any previous output is exactly as it was. Thrown — never returned beside a success — so no
 * caller can mistake "not written" for a build: `result` carries every finding (anchored where the
 * package would have landed) for a lane that publishes them, and the message names the errors for
 * one that does not. It is the skill's content the checks refused, so every packaging lane reads it
 * as {@link isSkillPackagingInputError} — the `SKILL_PACKAGING_FAILED` finding — unless it publishes
 * the findings themselves (`vat skills package`).
 */
export class SkillPackageChecksFailedError extends VatError {
  /** What the discarded package found: every post-build finding, and where it would have landed. */
  readonly result: PackageSkillResult;

  constructor(result: PackageSkillResult) {
    const errors = errorFindingsOf(result).map((issue) => {
      const at = issue.location === undefined ? '' : ' at ' + issue.location;
      return `${issue.code}${at}: ${issue.message}`;
    });
    super(
      SKILL_PACKAGE_CHECKS_FAILED_CODE,
      `skill '${result.skill.name}': the package failed its own post-build checks, so nothing was written to ${result.outputPath}: ${errors.join('; ')}`,
    );
    this.result = result;
  }
}

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
 * What the packager threw, as a lane that also reads sources of its own must see it: a
 * source-side fault raised INSIDE the packager becomes the packager's content refusal
 * ({@link packagingInputError}, the classified fault kept as its `cause`), so the lane
 * publishes it as the `SKILL_PACKAGING_FAILED` finding while its own source reads stay
 * their table refusal. Anything else is returned untouched. Catch it at the packager call.
 *
 * @param error - What a call to `packageSkill` threw
 */
export function asPackagerRefusal(error: unknown): unknown {
  return isFsFaultError(error) && isSkillPackagingInputError(error) ? packagingInputError(error.message, { cause: error }) : error;
}

/** The classes that say the MACHINE ran out or was momentarily busy: never a fact about the skill. */
const CAPACITY_CLASSES: ReadonlySet<FsFaultClass> = new Set(['exhausted', 'busy']);

/**
 * Whether `error` is the packager refusing the skill's content (the adopter's
 * to fix) — published by every packaging lane as the `SKILL_PACKAGING_FAILED`
 * finding — rather than a defect or a run that did not finish.
 *
 * That is a coded content refusal ({@link packagingInputError}, an unusable
 * name, or a package its own post-build checks failed), or a classified filesystem fault on the `source` side that is not a
 * capacity fault. A full disk or an exhausted descriptor table while reading the
 * source is the machine's, not the skill's: a refusal, never a finding. A
 * `destination` or `environment` fault is the run not finishing.
 *
 * @param error - What a caller of `packageSkill` caught
 */
export function isSkillPackagingInputError(error: unknown): boolean {
  if (isVatError(error, SKILL_PACKAGING_INPUT_INVALID_CODE) || isVatError(error, SKILL_NAME_NOT_A_SEGMENT_CODE)) return true;
  if (isVatError(error, SKILL_PACKAGE_CHECKS_FAILED_CODE)) return true;
  return isFsFaultError(error) && error.side === 'source' && !CAPACITY_CLASSES.has(error.faultClass);
}
