/**
 * `CONTENT_KEY_OPAQUE_ALLOW` in `eslint.config.js`, the files `local/content-key-opaque` lets read,
 * mint, order or compare a `ContentKey` by its text, asserted from the side the rule cannot see.
 *
 * The rule skips every listed file, so a listed file that stops touching the key's text is invisible
 * to `bun run lint` and its entry would stand open for the next offender. This lints each listed
 * file type-aware with the list lifted and requires a finding, so a clean entry fails here until it
 * is deleted. The other direction, an unlisted file that offends, is the lint gate itself.
 * Integration tier: the rule needs a typed program.
 */

import { compareCodeUnits } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { importRootEslintConfig } from '../eslint-clean-files.js';

import { typedFilesWithoutFinding } from './typed-list-ratchet.js';

/** The one `eslint.config.js` export this file reads: the files that own the key's format. */
const { CONTENT_KEY_OPAQUE_ALLOW } = await importRootEslintConfig<{ readonly CONTENT_KEY_OPAQUE_ALLOW: readonly string[] }>();

const RULE = 'local/content-key-opaque';

describe('CONTENT_KEY_OPAQUE_ALLOW only names files that still touch a ContentKey by its text', () => {
  it('is non-empty and sorted', () => {
    // The parser owns the format, so the list is never empty while the rule exists.
    expect(CONTENT_KEY_OPAQUE_ALLOW.length).toBeGreaterThan(0);
    expect(CONTENT_KEY_OPAQUE_ALLOW).toEqual(CONTENT_KEY_OPAQUE_ALLOW.toSorted(compareCodeUnits));
  });

  it('every listed file still trips the rule — remove the entry when it does not', async () => {
    expect(
      await typedFilesWithoutFinding(CONTENT_KEY_OPAQUE_ALLOW, { [RULE]: ['error', { allowFiles: [] }] }),
      `These files no longer trip ${RULE}. Delete their CONTENT_KEY_OPAQUE_ALLOW entries in eslint.config.js `
        + '— a stale entry hides the next offender.',
    ).toEqual([]);
  });
});
