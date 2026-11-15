/**
 * The refusals of a skill source that is fetched — a `url` source's archive — each coded, so a
 * failure to obtain it is published as what it is and never as a defect in VAT.
 */

import { VatError } from '@vibe-agent-toolkit/utils';

/**
 * The code of a {@link SkillSourceFetchError}: the source's bytes could not be obtained, or are
 * not the bytes the declaration pinned.
 */
export const SKILL_SOURCE_FETCH_FAILED_CODE = 'SKILL_SOURCE_FETCH_FAILED';

/**
 * A `url` skill source that could not be fetched — the server answered with a failure, did not
 * answer in time, sent more than VAT downloads — or whose bytes do not match the `sha256` its
 * declaration pins. Reason `preflight`: the operator fixes the URL, the digest or the network.
 */
export class SkillSourceFetchError extends VatError {
  readonly reason = 'preflight' as const;
  constructor(message: string, options?: ErrorOptions) {
    super(SKILL_SOURCE_FETCH_FAILED_CODE, message, options);
  }
}

/** The code of a {@link SkillSourceDigestRequiredError}. */
export const SKILL_SOURCE_DIGEST_REQUIRED_CODE = 'SKILL_SOURCE_DIGEST_REQUIRED';

/**
 * A `url` skill source naming a `.zip` with no `sha256`: an archive fetched over the network is
 * extracted only when its declaration pins its bytes. Reason `preflight`: the declaration's to fix.
 */
export class SkillSourceDigestRequiredError extends VatError {
  readonly reason = 'preflight' as const;
  constructor(url: string) {
    super(SKILL_SOURCE_DIGEST_REQUIRED_CODE, `url skill source '${url}' is a .zip and requires a sha256 integrity digest.`);
  }
}

/** The code of a {@link SkillStagingNotOwnedError}. */
export const SKILL_STAGING_NOT_OWNED_CODE = 'SKILL_STAGING_NOT_OWNED';

/**
 * A staging root or staged directory another user owns: VAT's own scratch, which it will not
 * write a skill into. Reason `preflight`: the operator removes it, or points staging elsewhere.
 */
export class SkillStagingNotOwnedError extends VatError {
  readonly reason = 'preflight' as const;
  constructor(dir: string, owner: number, currentUid: number) {
    super(
      SKILL_STAGING_NOT_OWNED_CODE,
      `Refusing to stage into '${dir}': directory ownership (uid ${owner}) does not match the current user (uid ${currentUid}). ` +
        'Possible shared-tmp attack. Remove it, or point staging elsewhere.',
    );
  }
}
